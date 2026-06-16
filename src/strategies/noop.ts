/**
 * noop — the reference strategy that proves the framework wiring end-to-end
 * without trading. It observes feed events and logs a heartbeat on a cadence.
 * Use it to validate that the runner connects, dispatches hooks, and shuts down
 * cleanly. Real strategies (market-maker, momentum) land in Phase 7.
 */
import type { Strategy } from "../engine/types.js";

interface NoopParams {
  /** Log a heartbeat every N onTick calls (default 10). */
  logEvery: number;
}

export function noopStrategy(): Strategy<NoopParams> {
  let ticks = 0;
  let trades = 0;
  let books = 0;

  return {
    name: "noop",

    parseParams(raw): NoopParams {
      const p = (raw ?? {}) as Record<string, unknown>;
      const logEvery = typeof p.logEvery === "number" && p.logEvery > 0 ? p.logEvery : 10;
      return { logEvery };
    },

    init(ctx) {
      ctx.logger.info("noop init", {
        network: ctx.config.network,
        params: ctx.params,
      });
    },

    onTrade() {
      trades++;
    },

    onBook() {
      books++;
    },

    onTick(ctx) {
      ticks++;
      if (ticks % ctx.params.logEvery === 0) {
        ctx.logger.info("noop heartbeat", {
          ticks,
          trades,
          books,
          openOrders: ctx.orders.open().length,
          positions: ctx.positions.list().length,
        });
      }
    },

    shutdown(ctx) {
      ctx.logger.info("noop shutdown", { ticks, trades, books });
    },
  };
}
