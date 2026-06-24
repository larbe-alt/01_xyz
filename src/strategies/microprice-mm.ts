import { Side } from "@n1xyz/nord-ts";
import type { WebSocketAccountUpdate } from "@n1xyz/nord-ts";
import type { Strategy, StrategyContext } from "../engine/types.js";
import type { LocalBook } from "../data/feed.js";
import { SessionTracker, type QuoteResult } from "../engine/session-tracker.js";
import { isUnlimited } from "../risk/limits.js";

interface MmParams {
  halfSpreadBps: number;
  skewK: number;
  orderSize: number;
  requoteMs: number;
  imbDepth: number;
}

function topNDepth(book: LocalBook, side: "bid" | "ask", n: number): number {
  const map = side === "bid" ? book.bids : book.asks;
  if (map.size === 0) return 0;

  const prices = Array.from(map.keys());
  prices.sort(side === "bid" ? (a, b) => b - a : (a, b) => a - b);

  let total = 0;
  const levels = Math.min(n, prices.length);
  for (let i = 0; i < levels; i++) total += map.get(prices[i])!;
  return total;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// p90 of |Δmid| in bps over a ~1s lookback. Single forward pass: j is monotonic
// across i since sample ts is monotonic, so total work is O(N), not O(N²).
function rollingP90Bps(samples: { ts: number; mid: number }[]): number | null {
  if (samples.length < 200) return null;
  const deltas: number[] = [];
  let j = 1;
  for (let i = 0; i < samples.length; i++) {
    if (j <= i) j = i + 1;
    while (j < samples.length && samples[j].ts - samples[i].ts < 1000) j++;
    if (j >= samples.length) break;
    if (samples[j].ts - samples[i].ts <= 3000) {
      deltas.push((Math.abs(samples[j].mid - samples[i].mid) / samples[i].mid) * 1e4);
    }
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length * 0.9)];
}

export function microPriceMm(): Strategy<MmParams> {
  const lastQuoteTs = new Map<string, number>();
  const recentMids = new Map<string, { ts: number; mid: number }[]>();
  const tracker = new SessionTracker();

  return {
    name: "microprice-mm",

    parseParams(raw): MmParams {
      const p = (raw ?? {}) as Record<string, unknown>;
      const halfSpreadBps = typeof p.halfSpreadBps === "number" && p.halfSpreadBps > 0 ? p.halfSpreadBps : 15;
      const skewK = typeof p.skewK === "number" ? p.skewK : 0.5;
      const orderSize = typeof p.orderSize === "number" && p.orderSize > 0 ? p.orderSize : 0.01;
      const requoteMs = typeof p.requoteMs === "number" && p.requoteMs > 0 ? p.requoteMs : 2000;
      const imbDepth = typeof p.imbDepth === "number" && p.imbDepth >= 1 ? Math.floor(p.imbDepth) : 5;
      return { halfSpreadBps, skewK, orderSize, requoteMs, imbDepth };
    },

    async init(ctx) {
      ctx.logger.info("microprice-mm init", { params: ctx.params });
      tracker.start(ctx);
      await ctx.orders.cancelAll();
    },

    async onBook(book: LocalBook, ctx: StrategyContext<MmParams>) {
      if (!book.synced) return;

      const symbol = book.symbol;
      const now = ctx.clock.now();
      if (now - (lastQuoteTs.get(symbol) ?? 0) < ctx.params.requoteMs) return;

      const { halfSpreadBps, skewK, orderSize, imbDepth } = ctx.params;
      const { bestBid, bestAsk } = book;
      if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return;

      const mid = (bestBid + bestAsk) / 2;

      // Rolling mid buffer (~30 min @ 1 Hz). Trim in batches so the per-event push
      // stays amortized O(1) — a per-event shift() is O(N) in V8.
      const midBuf = recentMids.get(symbol) ?? [];
      midBuf.push({ ts: now, mid });
      if (midBuf.length >= 2000) midBuf.splice(0, midBuf.length - 1800);
      recentMids.set(symbol, midBuf);

      const spread = bestAsk - bestBid;

      const bidDepth = topNDepth(book, "bid", imbDepth);
      const askDepth = topNDepth(book, "ask", imbDepth);
      if (bidDepth + askDepth === 0) return;
      const imbalance = bidDepth / (bidDepth + askDepth);

      const fair = mid + (imbalance - 0.5) * spread;

      const pos = ctx.positions.get(symbol);
      const inventory = pos ? (pos.isLong ? pos.baseSize.toNumber() : -pos.baseSize.toNumber()) : 0;

      const p90 = rollingP90Bps(midBuf);
      const effectiveBps = p90 !== null ? Math.max(halfSpreadBps, p90) : halfSpreadBps;
      const halfSpread = mid * effectiveBps * 0.0001;

      // Skew normalized against the per-symbol position cap so it bites at the limit
      // rather than disappearing in tick rounding.
      const maxInv = Number(ctx.risk.guard.getMarketConfig(symbol).maxPositionBase);
      let skew = 0;
      if (isUnlimited(maxInv)) {
        ctx.logger.warn("microprice-mm: maxPositionBase not set for symbol, skipping skew", { symbol });
      } else {
        skew = skewK * clamp(inventory / maxInv, -1, 1) * halfSpread;
      }

      const rawBid = fair - halfSpread - skew;
      const rawAsk = fair + halfSpread - skew;

      const bidPrice = ctx.registry.roundPrice(symbol, rawBid);
      const askPrice = ctx.registry.roundPrice(symbol, rawAsk);

      const meta = ctx.registry.bySymbol(symbol);
      const minSize = Math.pow(10, -meta.sizeDecimals);
      if (orderSize < minSize) {
        ctx.logger.warn("orderSize below minimum", { symbol, orderSize, minSize });
        return;
      }
      const size = ctx.registry.roundSize(symbol, orderSize);
      if (size.isZero()) return;

      await ctx.orders.cancelAll(symbol);

      const quotes: QuoteResult[] = [];
      const errors: string[] = [];

      try {
        const r = await ctx.orders.place({
          symbol,
          side: Side.Bid,
          type: "postOnly",
          price: bidPrice,
          size,
        });
        quotes.push({ side: "bid", result: r });
      } catch (e: any) {
        errors.push(`bid: ${e.message}`);
      }

      try {
        const r = await ctx.orders.place({
          symbol,
          side: Side.Ask,
          type: "postOnly",
          price: askPrice,
          size,
        });
        quotes.push({ side: "ask", result: r });
      } catch (e: any) {
        errors.push(`ask: ${e.message}`);
      }

      lastQuoteTs.set(symbol, now);
      tracker.onQuote(ctx, symbol, fair, quotes);

      if (effectiveBps > 2 * halfSpreadBps) {
        ctx.logger.warn("microprice-mm: regime widening", { symbol, effectiveBps, floor: halfSpreadBps });
      }

      ctx.logger.info("quote", {
        symbol,
        fair: fair.toFixed(2),
        bid: bidPrice.toString(),
        ask: askPrice.toString(),
        imb: imbalance.toFixed(3),
        inv: inventory,
        skew: skew.toFixed(4),
        effHalfSpreadBps: effectiveBps.toFixed(2),
        ...(errors.length > 0 && { errors }),
      });
    },

    onAccount(u: WebSocketAccountUpdate, ctx: StrategyContext<MmParams>) {
      const now = ctx.clock.now();
      const posBySymbol = new Map<string, number>();
      for (const fill of Object.values(u.fills)) {
        let symbol: string;
        try {
          symbol = ctx.registry.byId(fill.market_id).symbol;
        } catch {
          ctx.logger.warn("microprice-mm onAccount: unknown market_id in fill", { market_id: fill.market_id });
          continue;
        }
        let positionAfter = posBySymbol.get(symbol);
        if (positionAfter === undefined) {
          const pos = ctx.positions.get(symbol);
          positionAfter = pos ? (pos.isLong ? pos.baseSize.toNumber() : -pos.baseSize.toNumber()) : 0;
          posBySymbol.set(symbol, positionAfter);
        }
        // fair-at-fill unknown here; slippage reported as 0 for resting-order fills.
        tracker.onFill({
          ts: now,
          symbol,
          side: fill.side,
          price: fill.price,
          size: fill.quantity,
          slippageBps: 0,
          fairAtFill: 0,
          positionAfter,
        });
      }
    },

    async shutdown(ctx) {
      await ctx.orders.cancelAll();
      const summary = tracker.finish(ctx);
      ctx.logger.info("\n" + SessionTracker.formatSummary(summary));
    },
  };
}
