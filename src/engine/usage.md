# Strategy Engine

The framework that runs trading strategies. A strategy implements the `Strategy`
contract and only ever touches the `StrategyContext` it's handed — it never calls
the SDK or core managers directly. Every order is routed through a guarded facade
so the risk layer runs on every entry automatically.

The engine *runs* strategies; the strategies themselves live in `src/strategies/`.

## Quick start

```bash
# Run a strategy from a config file
npm run strategy -- --config examples/noop.config.json

# Override the strategy name, log intended orders without sending them
npm run strategy -- --config examples/noop.config.json --strategy noop --dry-run

# Backtest against recorded data (forces dry-run)
npm run strategy -- --config examples/noop.config.json --replay ./data
```

Ctrl+C shuts down gracefully: runs `shutdown` → cancels all orders → optionally
flattens → drains the write queue. A second Ctrl+C (or a 10s timeout) force-exits.

## CLI flags

| Flag         | Argument    | Description                                                        |
|--------------|-------------|-------------------------------------------------------------------|
| `--config`   | path        | **Required.** JSON config file (`StrategyFileConfig`)             |
| `--strategy` | name        | Strategy to run; overrides `config.strategy`                      |
| `--dry-run`  | —           | Guard-check + log orders, but never send them                    |
| `--replay`   | `[baseDir]` | Replay recorded data instead of live; forces `--dry-run`         |

## Config — the three-layer split

A config file (`StrategyFileConfig`) separates three concerns so they never bleed
into each other:

```jsonc
{
  "strategy": "noop",          // which strategy (registry name)

  "run": {                     // how the ENGINE runs
    "markets": ["BTCUSD"],
    "tickMs": 1000,            // onTick cadence (default 1000)
    "candleResolution": "1",   // subscribe candles when set
    "refreshMs": 15000,        // account.fetchInfo() cadence (default 15000)
    "flattenOnShutdown": false
  },

  "risk": {                    // RiskConfig — safety limits (shared, all strategies)
    "markets": [
      { "symbol": "BTCUSD", "maxPositionBase": 0.01, "maxOrderNotional": 500,
        "maxLeverage": 3, "maxOpenOrders": 4 }
    ],
    "defaultMaxLeverage": 3,
    "maxTotalGrossNotional": 2000,
    "minMarginBufferPct": 0.2,
    "maxDailyLossUsdc": 50,
    "maxAccountAgeSec": 30
  },

  "params": {                  // STRATEGY-specific knobs — opaque to the framework
    "logEvery": 5
  },

  "dryRun": false,             // optional; --dry-run also sets this
  "replay": {                  // optional; only used with --replay
    "baseDir": "./data", "env": "devnet", "speed": 10
  }
}
```

| Layer    | Owns                    | Understood by | Example knobs                          |
|----------|-------------------------|---------------|----------------------------------------|
| `run`    | how the engine runs     | framework     | markets, tickMs, candleResolution      |
| `risk`   | safety limits           | risk layer    | maxLeverage, maxDailyLossUsdc          |
| `params` | the strategy's own knobs| **the strategy** | spread, EMA periods, size           |

`params` is opaque JSON. The strategy validates it in `parseParams()` (fail fast
on bad config). This is how each strategy gets its own settings without the runner
knowing anything about them.

## The `Strategy` contract

Implement this and register a name (see *Adding a strategy*). All hooks except
`init` are optional.

```ts
interface Strategy<P = unknown> {
  name: string;
  parseParams?(raw: unknown): P;                              // validate config.params → typed P
  init(ctx): Promise<void> | void;                            // called once at start
  onTrade?(t: FeedTrade, ctx): Promise<void> | void;          // every trade
  onBook?(book: LocalBook, ctx): Promise<void> | void;        // every book update
  onCandle?(c: FeedCandle, ctx): Promise<void> | void;        // every candle
  onTick?(ctx): Promise<void> | void;                         // fixed interval (live only)
  onAccount?(u: WebSocketAccountUpdate, ctx): Promise<void> | void; // own fills/balance changes
  shutdown?(ctx): Promise<void> | void;                       // on stop
}
```

Hook dispatch is **serialized**: synchronous hooks run inline; an async hook
pauses the queue until it settles, so hooks can never overlap or re-enter and
corrupt strategy state. `onTick` is skipped if a prior hook is still running.

## The `StrategyContext`

The only surface a strategy uses:

| Field         | Type                | What it gives you                                            |
|---------------|---------------------|-------------------------------------------------------------|
| `orders`      | `GuardedOrders`     | place/edit/cancel/market — **risk-checked automatically**   |
| `positions`   | `PositionManager`   | list, get, liquidationPrice, close                          |
| `balances`    | `BalanceManager`    | exchange/free/onchain balances                              |
| `account`     | `AccountState`      | equity, marginUsage, refresh, ageMs                         |
| `feed`        | `FeedSource`        | getBook/getMid/getBestBid/getBestAsk (live or replay)       |
| `risk`        | `{ guard, sizeFromRisk, notionalToBase }` | size-from-risk, manual guard access     |
| `registry`    | `{ bySymbol, byId, roundPrice, roundSize }` | market metadata + tick rounding       |
| `logger`      | `Logger`            | structured logging                                          |
| `config`      | `Config`            | network, endpoints                                          |
| `params`      | `P`                 | your validated strategy params                              |
| `clock`       | `{ now, serverNow }`| local + server-synced time                                  |

## Risk enforcement (important)

Strategies receive `ctx.orders`, a **`GuardedOrders` facade** — not the raw
`OrderManager`. Every `place` / `edit` / `marketBuy` / `marketSell`:

1. resolves a mark price (synced-book mid, else the limit price),
2. assembles the guard state (equity, IMF, positions, open orders, account age),
3. runs `guard.check()`,
4. throws `GuardRejectedError` if denied — otherwise places the order.

If no reliable mark price is available (book unsynced *and* no limit price) the
order is **rejected** rather than risk-checked against a bad mark — this prevents
a market order from bypassing notional/leverage caps. `cancel` and read paths
pass through unchecked. Reduce-only orders are always allowed (the guard lets you
close positions even when the kill-switch is active).

## Dry-run & replay

- `--dry-run`: orders are guard-checked and logged but never sent. Note this only
  covers `ctx.orders.*` — calling `ctx.positions.close()` directly still submits a
  real reduce-only order.
- `--replay <dir>`: swaps the live feed for `ReplayFeed` behind the **same context**
  — the strategy runs unchanged. Replay forces dry-run (you can't place into the
  past), is data-driven (the wall-clock `onTick` and account-refresh timers are
  disabled), and `onAccount` never fires (no account stream in recordings).

## Adding a strategy

1. Create `src/strategies/my-strategy.ts` exporting a factory:

```ts
import type { Strategy } from "../engine/types.js";

interface MyParams { spreadBps: number }

export function myStrategy(): Strategy<MyParams> {
  return {
    name: "my-strategy",
    parseParams(raw) {
      const p = (raw ?? {}) as Record<string, unknown>;
      if (typeof p.spreadBps !== "number") throw new Error("spreadBps required");
      return { spreadBps: p.spreadBps };
    },
    init(ctx)   { ctx.logger.info("up", { params: ctx.params }); },
    onBook(book, ctx) { /* quote around (book.bestBid + book.bestAsk) / 2 */ },
    shutdown(ctx) { /* cleanup */ },
  };
}
```

2. Register it in `src/strategies/index.ts`:

```ts
registerStrategy("my-strategy", () => myStrategy());
```

3. Run it: `npm run strategy -- --config my-strategy.config.json`

## Lifecycle

```
start():  getNord/getUser → init registry → build managers + feed + guard
          → account.refresh() → capture sessionStartEquity → strategy.init()
          → wire feed events → start tick + refresh timers → install SIGINT
          → feed.start()

run:      feed "trade"→onTrade, "book"→onBook, "candle"→onCandle,
          "account"→(refresh)→onAccount; interval→onTick   (all serialized)

stop:     stop timers → feed.stop() → strategy.shutdown()
          → (live) account.refresh() → cancelAll() → optional flatten
          → queue.drain() → close client
```

The kill-switch (tripped by the daily-loss check or manually via `ctx.risk.guard`)
runs `cancelAll()` + flatten as `onTrip`; `flatten()` is single-flight so a
kill-switch trip and a concurrent shutdown can't double-close.

## Files

| File          | Purpose                                                         |
|---------------|-----------------------------------------------------------------|
| `types.ts`    | `Strategy` contract, `StrategyContext`, normalized feed + config types |
| `context.ts`  | `GuardedOrders` facade + `buildContext()` + `GuardRejectedError` |
| `runner.ts`   | `StrategyRunner` — wiring, serialized dispatch, timers, shutdown |
| `registry.ts` | strategy name → factory (`registerStrategy` / `createStrategy`)  |

Related: feed normalization lives in `src/data/feed-source.ts` (`FeedSource`,
`LiveFeedSource`, `ReplayFeedSource`); the CLI is `src/scripts/run-strategy.ts`.
