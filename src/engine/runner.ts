/**
 * StrategyRunner — the Phase 6 engine.
 *
 * Wires core managers + feed + risk into a StrategyContext, dispatches feed
 * events to the strategy's hooks, runs onTick on an interval, refreshes account
 * state on a cadence, and on shutdown (SIGINT) runs the strategy's shutdown,
 * cancels all orders, and optionally flattens. Works against a live feed or a
 * replay feed behind the same context.
 *
 * Replay note: replay is event-driven by the recorded stream, so the wall-clock
 * onTick timer and the periodic account refresh are disabled there, and orders
 * are forced to dry-run (you can't place into the past).
 */
import type { Nord } from "@n1xyz/nord-ts";
import type { WebSocketAccountUpdate } from "@n1xyz/nord-ts";
import { getConfig, getNord, getUser, close as closeClient } from "../client.js";
import type { Config } from "../config.js";
import { initMarkets } from "../registry/markets.js";
import { initTokens } from "../registry/tokens.js";
import { WriteQueue } from "../core/queue.js";
import { AccountState } from "../core/account.js";
import { OrderManager } from "../core/orders.js";
import { PositionManager } from "../core/positions.js";
import { BalanceManager } from "../core/balances.js";
import { RiskGuard } from "../risk/guard.js";
import { LiveFeed, type FeedOptions, type LocalBook } from "../data/feed.js";
import { ReplayFeed } from "../data/recorder/replay.js";
import { LiveFeedSource, ReplayFeedSource, type FeedSource } from "../data/feed-source.js";
import { GuardedOrders, buildContext } from "./context.js";
import type { Strategy, StrategyContext, RunConfig, ReplayConfig, FeedTrade, FeedCandle } from "./types.js";
import { createLogger } from "../utils/logger.js";

export interface ResolvedRunOptions {
  run: RunConfig;
  risk: import("../risk/limits.js").RiskConfig;
  params: unknown;
  dryRun: boolean;
  replay?: ReplayConfig;
}

export class StrategyRunner {
  private readonly log = createLogger("engine:runner");
  private config!: Config;
  private feed!: FeedSource;
  private ctx!: StrategyContext;
  private queue!: WriteQueue;
  private account!: AccountState;
  private orders!: OrderManager;
  private positions!: PositionManager;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  // Hook dispatch is serialized: sync hooks run inline (no microtask), async hooks
  // pause the queue until they settle so strategy state can't be corrupted by overlap.
  private readonly hookQueue: Array<{ hook: string; fn: () => unknown }> = [];
  private hookBusy = false;
  // Single-flight flatten so the kill-switch onTrip and shutdown can't double-close.
  private flattening: Promise<void> | null = null;

  constructor(
    private readonly strategy: Strategy<any>,
    private readonly opts: ResolvedRunOptions,
  ) {}

  async start(): Promise<void> {
    const { run, risk } = this.opts;
    this.config = getConfig();
    const nord = await getNord();
    initMarkets(nord);
    initTokens(nord);

    const user = await getUser();
    this.queue = new WriteQueue();
    this.account = new AccountState(nord, user, this.queue);
    this.orders = new OrderManager(nord, user, this.queue, this.account);
    this.positions = new PositionManager(nord, user, this.queue, this.account);
    const balances = new BalanceManager(nord, user, this.queue, this.account);

    await this.account.refresh();
    const sessionStartEquity = this.account.equity();

    const guard = new RiskGuard(risk, async () => {
      this.log.warn("Kill-switch tripped — cancelling all + flattening");
      try {
        await this.orders.cancelAll();
      } catch (e) {
        this.log.error("cancelAll (onTrip) failed", { e: errMsg(e) });
      }
      await this.flatten();
    });

    this.feed = this.buildFeed(nord);

    const guardedOrders = new GuardedOrders(this.orders, {
      guard,
      account: this.account,
      positions: this.positions,
      feed: this.feed,
      sessionStartEquity,
      dryRun: this.opts.dryRun,
    });

    const params = this.strategy.parseParams
      ? this.strategy.parseParams(this.opts.params)
      : ((this.opts.params ?? {}) as unknown);

    this.ctx = buildContext({
      orders: guardedOrders,
      positions: this.positions,
      balances,
      account: this.account,
      feed: this.feed,
      guard,
      config: this.config,
      params,
      logger: createLogger(`strategy:${this.strategy.name}`),
    });

    this.wireFeed();
    await this.strategy.init(this.ctx);
    this.startTimers();
    this.installSignals();

    this.log.info("Strategy started", {
      strategy: this.strategy.name,
      markets: run.markets,
      mode: this.opts.replay ? "replay" : "live",
      dryRun: this.opts.dryRun,
    });

    // ReplayFeed.start() resolves when playback finishes → auto-stop.
    const started = this.feed.start();
    if (started instanceof Promise) {
      await started;
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info("Stopping strategy", { strategy: this.strategy.name });

    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.feed.stop();

    try {
      await this.strategy.shutdown?.(this.ctx);
    } catch (e) {
      this.log.error("shutdown hook failed", { e: errMsg(e) });
    }

    if (!this.opts.dryRun) {
      // Resync first so cancelAll/flatten act on the true live order/position set,
      // not a snapshot frozen before the last acks.
      try {
        await this.account.refresh();
      } catch (e) {
        this.log.error("refresh before shutdown cancel failed", { e: errMsg(e) });
      }
      try {
        await this.orders.cancelAll();
      } catch (e) {
        this.log.error("cancelAll on shutdown failed", { e: errMsg(e) });
      }
      if (this.opts.run.flattenOnShutdown) await this.flatten();
    }

    await this.queue.drain().catch(() => {});
    await closeClient();
    this.log.info("Runner stopped");
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────

  private buildFeed(nord: Nord): FeedSource {
    if (this.opts.replay) {
      const rep = new ReplayFeed({
        baseDir: this.opts.replay.baseDir,
        env: this.opts.replay.env ?? this.config.network,
        markets: this.opts.run.markets,
        streams: ["trade", "delta", "snapshot", "candle"],
        from: this.opts.replay.from,
        to: this.opts.replay.to,
        speed: this.opts.replay.speed,
      });
      return new ReplayFeedSource(rep);
    }

    const feedOpts: FeedOptions = {
      trades: this.opts.run.markets,
      deltas: this.opts.run.markets,
      accounts: [this.account.accountId],
      candles: this.opts.run.candleResolution
        ? this.opts.run.markets.map((symbol) => ({ symbol, resolution: this.opts.run.candleResolution! }))
        : undefined,
    };
    return new LiveFeedSource(new LiveFeed(nord, feedOpts));
  }

  private wireFeed(): void {
    this.feed.on("trade", (t: FeedTrade) => this.dispatch("onTrade", () => this.strategy.onTrade?.(t, this.ctx)));
    this.feed.on("book", (_symbol: string, book: LocalBook) =>
      this.dispatch("onBook", () => this.strategy.onBook?.(book, this.ctx)),
    );
    this.feed.on("candle", (c: FeedCandle) => this.dispatch("onCandle", () => this.strategy.onCandle?.(c, this.ctx)));
    this.feed.on("account", (u: WebSocketAccountUpdate) =>
      this.dispatch("onAccount", async () => {
        await this.account.refresh(); // a fill changed our state — resync before the hook
        await this.strategy.onAccount?.(u, this.ctx);
      }),
    );
    this.feed.on("error", (e: unknown) => {
      this.log.error("feed error", { e: errMsg(e) });
      // LiveFeed emits this terminal error once it gives up reconnecting — don't sit
      // idle forever on stale state; stop so the operator/process supervisor notices.
      if (errMsg(e).includes("Max reconnect")) {
        this.log.error("Feed gave up reconnecting — stopping runner");
        void this.stop();
      }
    });
    this.feed.on("reconnecting", (n: number) => this.log.warn("feed reconnecting", { attempt: n }));
  }

  private startTimers(): void {
    if (this.opts.replay) return; // replay is data-driven; wall-clock timers don't apply

    if (this.strategy.onTick) {
      const tickMs = this.opts.run.tickMs ?? 1000;
      this.tickTimer = setInterval(() => {
        // Skip this tick if hooks are still draining — never let onTick pile up.
        if (this.hookBusy || this.hookQueue.length > 0) return;
        this.dispatch("onTick", () => this.strategy.onTick!(this.ctx));
      }, tickMs);
    }

    const refreshMs = this.opts.run.refreshMs ?? 15_000;
    this.refreshTimer = setInterval(() => {
      this.account.refresh().catch((e) => this.log.error("account refresh failed", { e: errMsg(e) }));
    }, refreshMs);
  }

  private installSignals(): void {
    process.once("SIGINT", () => {
      this.log.info("SIGINT received — shutting down (Ctrl-C again to force-exit)");
      // Escape hatch: if stop() hangs (e.g. queue.drain() stuck retrying on a dead
      // network), force-exit after a timeout instead of hanging forever.
      const force = setTimeout(() => {
        this.log.error("Shutdown timed out — forcing exit");
        process.exit(1);
      }, 10_000);
      force.unref?.();
      // A second Ctrl-C hard-exits immediately.
      process.once("SIGINT", () => {
        this.log.error("Second SIGINT — hard exit");
        process.exit(1);
      });
      this.stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }

  /** Reduce-only close every open position. Single-flight so onTrip + shutdown can't double-close. */
  private async flatten(): Promise<void> {
    if (this.flattening) return this.flattening;
    this.flattening = (async () => {
      try {
        await this.account.refresh().catch(() => {}); // close against fresh positions, not stale
        for (const p of this.positions.list()) {
          try {
            await this.positions.close(p.symbol);
          } catch (e) {
            this.log.error("flatten failed", { symbol: p.symbol, e: errMsg(e) });
          }
        }
      } finally {
        this.flattening = null;
      }
    })();
    return this.flattening;
  }

  /**
   * Serialized hook dispatch. Sync hooks run inline in a tight loop (no microtask,
   * no per-event promise — keeps the per-tick path allocation-light). An async hook
   * pauses the queue until it settles, so async hooks can never overlap/re-enter and
   * corrupt strategy state or double-submit orders.
   */
  private dispatch(hook: string, fn: () => unknown): void {
    this.hookQueue.push({ hook, fn });
    this.drainHooks();
  }

  private drainHooks(): void {
    if (this.hookBusy) return;
    while (this.hookQueue.length > 0) {
      const next = this.hookQueue.shift()!;
      this.hookBusy = true;
      let result: unknown;
      try {
        result = next.fn();
      } catch (e) {
        this.log.error(`hook ${next.hook} threw`, { e: errMsg(e) });
        this.hookBusy = false;
        continue;
      }
      if (result != null && typeof (result as { then?: unknown }).then === "function") {
        (result as Promise<unknown>).then(
          () => {
            this.hookBusy = false;
            this.drainHooks();
          },
          (e) => {
            this.log.error(`hook ${next.hook} threw`, { e: errMsg(e) });
            this.hookBusy = false;
            this.drainHooks();
          },
        );
        return; // async hook in flight — resume draining when it settles
      }
      this.hookBusy = false; // sync hook done — continue the loop
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
