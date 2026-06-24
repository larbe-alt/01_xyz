/**
 * Paged reader over the `getTrades` REST endpoint.
 *
 * The endpoint returns one page of identified trades plus a `nextStartInclusive`
 * cursor; when it comes back null/undefined there's no more data. We page by
 * trade ID (paginationMode: "tradeId") — the cursor is the first trade of the
 * next page, so consecutive pages don't overlap.
 *
 * `iterateTrades` flattens that into a single async stream the backfill drains,
 * keeping pagination out of the writer's concern.
 */
import type { Nord, TradeFromApi } from "@n1xyz/nord-ts";

export interface TradesQuery {
  marketId?: number;
  takerId?: number;
  makerId?: number;
  takerSide?: "bid" | "ask";
  since?: string; // RFC3339, inclusive lower bound
  until?: string; // RFC3339, exclusive/inclusive upper bound (server-defined)
  pageSize?: number; // default 100 (server rejects pages larger than 100)
  startInclusive?: number; // resume cursor (trade ID)
}

export interface PageInfo {
  pages: number; // pages fetched so far (1-based, after this page)
  rows: number; // rows on this page
  total: number; // cumulative rows yielded
  lastTradeId: number | null; // highest trade ID seen so far
}

/**
 * Yield every trade matching `q`, walking pages until the cursor runs out.
 * `onPage` (optional) fires once per fetched page for progress logging.
 */
export async function* iterateTrades(
  nord: Nord,
  q: TradesQuery,
  onPage?: (info: PageInfo) => void,
): AsyncGenerator<TradeFromApi> {
  const pageSize = q.pageSize ?? 100;
  let cursor = q.startInclusive;
  let pages = 0;
  let total = 0;
  let lastTradeId: number | null = null;

  for (;;) {
    const res = await nord.getTrades({
      marketId: q.marketId,
      takerId: q.takerId,
      makerId: q.makerId,
      takerSide: q.takerSide,
      since: q.since,
      until: q.until,
      pageSize,
      startInclusive: cursor,
      paginationMode: "tradeId",
    });

    pages++;
    total += res.items.length;
    for (const t of res.items) {
      lastTradeId = t.tradeId;
      yield t;
    }
    onPage?.({ pages, rows: res.items.length, total, lastTradeId });

    if (res.nextStartInclusive == null) break;
    cursor = res.nextStartInclusive;
  }
}
