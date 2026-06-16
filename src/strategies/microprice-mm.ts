import { Side } from "@n1xyz/nord-ts";
import type { Strategy, StrategyContext } from "../engine/types.js";
import type { LocalBook } from "../data/feed.js";
import { SessionTracker, type QuoteResult } from "../engine/session-tracker.js";

interface MmParams {
  halfSpreadBps: number;
  skewK: number;
  orderSize: number;
  requoteMs: number;
  imbDepth: number;
}

const SYMBOL = "ETHUSD";

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

export function microPriceMm(): Strategy<MmParams> {
  let lastQuoteTs = 0;
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
      ctx.logger.info("microprice-mm init", { symbol: SYMBOL, params: ctx.params });
      tracker.start(ctx);
      await ctx.orders.cancelAll(SYMBOL);
    },

    async onBook(book: LocalBook, ctx: StrategyContext<MmParams>) {
      if (book.symbol !== SYMBOL || !book.synced) return;

      const now = ctx.clock.now();
      if (now - lastQuoteTs < ctx.params.requoteMs) return;

      const { halfSpreadBps, skewK, orderSize, imbDepth } = ctx.params;
      const { bestBid, bestAsk } = book;
      if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return;

      const mid = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;

      const bidDepth = topNDepth(book, "bid", imbDepth);
      const askDepth = topNDepth(book, "ask", imbDepth);
      if (bidDepth + askDepth === 0) return;
      const imbalance = bidDepth / (bidDepth + askDepth);

      const fair = mid + (imbalance - 0.5) * spread;

      const pos = ctx.positions.get(SYMBOL);
      const inventory = pos ? (pos.isLong ? pos.baseSize.toNumber() : -pos.baseSize.toNumber()) : 0;
      const skew = skewK * inventory * mid * 0.0001;

      const halfSpread = mid * halfSpreadBps * 0.0001;
      const rawBid = fair - halfSpread - skew;
      const rawAsk = fair + halfSpread - skew;

      const bidPrice = ctx.registry.roundPrice(SYMBOL, rawBid);
      const askPrice = ctx.registry.roundPrice(SYMBOL, rawAsk);

      const meta = ctx.registry.bySymbol(SYMBOL);
      const minSize = Math.pow(10, -meta.sizeDecimals);
      if (orderSize < minSize) {
        ctx.logger.warn("orderSize below minimum", { orderSize, minSize });
        return;
      }
      const size = ctx.registry.roundSize(SYMBOL, orderSize);
      if (size.isZero()) return;

      await ctx.orders.cancelAll(SYMBOL);

      const quotes: QuoteResult[] = [];
      const errors: string[] = [];

      try {
        const r = await ctx.orders.place({
          symbol: SYMBOL,
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
          symbol: SYMBOL,
          side: Side.Ask,
          type: "postOnly",
          price: askPrice,
          size,
        });
        quotes.push({ side: "ask", result: r });
      } catch (e: any) {
        errors.push(`ask: ${e.message}`);
      }

      lastQuoteTs = now;
      tracker.onQuote(ctx, SYMBOL, fair, quotes);

      ctx.logger.info("quote", {
        fair: fair.toFixed(2),
        bid: bidPrice.toString(),
        ask: askPrice.toString(),
        imb: imbalance.toFixed(3),
        inv: inventory,
        skew: skew.toFixed(4),
        ...(errors.length > 0 && { errors }),
      });
    },

    async shutdown(ctx) {
      await ctx.orders.cancelAll(SYMBOL);
      const summary = tracker.finish(ctx);
      ctx.logger.info("\n" + SessionTracker.formatSummary(summary));
    },
  };
}
