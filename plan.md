# 01 Exchange Trading Bot — Build Plan

A staged plan to build a reusable trading stack on top of `@n1xyz/nord-ts` (v0.5.1):
a **tick/candle/trade recorder**, **core universal modules** (orders, positions,
balances, account), a **risk layer**, and a **strategy pipeline** that lets any
strategy plug in and trade fast against the core modules.

Grounded in the SDK reference under [`docs/sdk/`](./docs/sdk/), the installed type
declarations in `node_modules/@n1xyz/nord-ts/dist/`, and the official docs at
<https://docs.01.xyz/reference/> and <https://docs.01.xyz/examples/>.

---

## 0. Current state

```
src/client.ts   — Nord + NordUser singletons (getNord / getUser) ✅ keep, extend
src/index.ts    — entry stub
scripts/ws/probe.py — WS keepalive finding: server kills lib-level ping;
                      use ping_interval=None + data-stream liveness timeout
docs/sdk/*      — full SDK reference (public client, user, admin)
```

Stack: TypeScript (ESM, `tsx`), `@n1xyz/nord-ts`, `@solana/web3.js`, `decimal.js`
(transitive via SDK). Target: devnet first (`zo-devnet.n1.xyz`), then mainnet.

### Key SDK facts that shape the design

- **Money math is `Decimal` (decimal.js)** everywhere — never use JS `number` for
  prices/sizes. The SDK ships math utils we should reuse rather than reinvent:
  - `mathUtils/trading` → `calcSlippage`
  - `mathUtils/margin` → `calcCurrPosLiqPrice`, `calcPosMaintenanceMargin`,
    `getPositionMargin`, `getAccountMarginUsageRatio`, `getPerpsCrossMarginRatio`
  - `mathUtils/pnl` → `estimateClosePnl`
- **WebSocket**: `nord.createWebSocketClient({ trades, deltas, accounts, candles, liquidations })`
  is an `EventEmitter` (`connected`/`disconnected`/`error`/`trade`/`delta`/`account`/`candle`/`liquidation`).
  Endpoints are stream-typed (a `trades@…` sub only valid on the trades endpoint).
  **Per `scripts/ws/probe.py`**: don't rely on lib ping; treat data silence
  (>~15s) as death and reconnect with backoff.
- **Atomic batch**: `user.atomic([...])` runs up to 10 subactions atomically
  (cancel / cancelByClientId / place / addTrigger / editTrigger / removeTrigger).
  Per-market phase order: cancels → trades → placements. This is the primitive
  for fast quote replacement and safe entry+stop.
- **Orders**: `placeOrder` (Limit/PostOnly/IOC/FOK, `clientOrderId`,
  `selfTradePrevention`, `isReduceOnly`, `size` or `quoteSize`), `cancelOrder`,
  `cancelOrderByClientId`.
- **State after `fetchInfo()`**: `user.balances`, `user.orders`, `user.positions`,
  `user.margins` (omf/mf/imf/cmf/mmf/pon/pn/bankruptcy), `user.accountIds`.
- **Triggers**: SL/TP via `addTrigger`/`editTrigger`/`removeTrigger`, max 16/position.

---

## 1. Target architecture

```
src/
  client.ts            # Nord + NordUser singletons (exists; extend w/ lifecycle)
  config.ts            # env loading, endpoints, defaults, validation
  registry/
    markets.ts         # symbol<->marketId, price/size decimals, tick sizes, MMF/IMF
    tokens.ts          # token ids, decimals, symbols
  core/                # UNIVERSAL, strategy-agnostic building blocks
    orders.ts          # OrderManager: place / cancel / edit(=cancel+place or atomic) / get
    positions.ts       # PositionManager: list, liq price, unrealized pnl, close
    balances.ts        # BalanceManager: exchange balances + on-chain SPL
    account.ts         # AccountState: margins, equity, usage ratios, refresh
    batch.ts           # AtomicBuilder: typed wrapper over user.atomic([...])
  data/
    feed.ts            # LiveFeed: managed WS w/ reconnect + liveness (probe.py rules)
    recorder/
      recorder.ts      # subscribes feeds -> normalizes -> writers
      schema.ts        # record types: tick, trade, candle, delta, account
      writers.ts       # pluggable sinks: JSONL (v1), SQLite/Parquet (v2)
      replay.ts        # read recorded data back as a feed (for backtest)
  risk/
    sizing.ts          # position size from risk %, notional caps, leverage caps
    guard.ts           # pre-trade gate: margin, max position, max drawdown, kill-switch
    limits.ts          # static + runtime risk config & evaluation
  strategy/
    types.ts           # Strategy interface, StrategyContext, lifecycle hooks
    context.ts         # wires core modules + feed + risk into a context object
    runner.ts          # engine: event loop, schedules onTick/onTrade, shutdown
    strategies/
      market-maker.ts  # strategy #1: two-sided quoting via atomic replace
      momentum.ts      # strategy #2: candle/trend follow w/ SL/TP triggers
  utils/
    logger.ts          # structured logging (json lines + pretty console)
    decimal.ts         # Decimal helpers (round to tick, clamp, fmt)
    retry.ts           # backoff/retry for RPC + action submission
    time.ts            # server-time sync (nord.getTimestamp), interval helpers
  scripts/
    record.ts          # CLI: record N markets to disk
    run-strategy.ts    # CLI: run a named strategy with a config file
    smoke.ts           # CLI: connectivity + read-only sanity checks
```

Design rule: **strategies never call the SDK directly** — they only use
`StrategyContext` (core modules + feed + risk). This keeps strategies small and
makes a 3rd, 4th strategy trivial to add.

---

## 2. Phased delivery

### Phase 0 — Foundations & tooling
**Goal:** typed config, logging, decimal/time/retry utils, dev ergonomics.

> **📖 Read first**
> - Repo: [`src/client.ts`](./src/client.ts), [`.env.example`](./.env.example), [`docs/sdk/README.md`](./docs/sdk/README.md)
> - Docs: <https://docs.01.xyz/> → *Getting Started* (Installation, Setup, Key Components), *Testnet*
> - SDK ref: [`docs/sdk/nord-public-client.md`](./docs/sdk/nord-public-client.md) → *Initialization*, *Action Log* (`getTimestamp`, `getLastActionId`)
> - SDK ref: [`docs/sdk/nord-user.md`](./docs/sdk/nord-user.md) → *Initialization* (`fromKeypair`, `updateAccountId`, `fetchInfo`)
> - Types: `node_modules/@n1xyz/nord-ts/dist/index.d.ts`, `dist/const.d.ts`, `dist/error.d.ts`
- `config.ts`: load/validate env (`SOLANA_RPC`, `WEB_SERVER_URL`, `APP_KEY`,
  `PRIVATE_KEY`), expose typed `Config`; fail fast with clear errors. Network
  presets for devnet/mainnet (incl. WS host).
- `utils/logger.ts`, `utils/decimal.ts` (tick rounding, formatting),
  `utils/retry.ts` (exp backoff), `utils/time.ts` (server-time offset via
  `nord.getTimestamp()`).
- Extend `client.ts`: graceful init/close, expose the WS host, `dotenv` loading.
- Add npm scripts: `record`, `strategy`, `smoke`, `typecheck`, `build`.
- `scripts/smoke.ts`: `getInfo`, `getMarketsLive`, `getOrderbook`, and (if
  `PRIVATE_KEY`) `updateAccountId` + `fetchInfo` — prints balances/positions.

**Done when:** `npm run smoke` connects on devnet and prints market + account state.

---

### Phase 1 — Registry (markets & tokens)
**Goal:** one source of truth for symbol↔id, decimals, tick sizes, margin params.

> **📖 Read first**
> - Docs: <https://docs.01.xyz/reference/> → *Market Data & Info*, REST `/info`, `/markets/live`, `/market/[id]/stats`
> - Docs: <https://docs.01.xyz/> → *Margins* (Account Margins, Risk Framework) for `imfBps`/`mmfBps`/`cmfBps` meaning
> - SDK ref: [`docs/sdk/nord-public-client.md`](./docs/sdk/nord-public-client.md) → *Market Data* (`getInfo`, `getMarketsLive`, `getMarketLive`, `getMarketStats`, `getTokenStats`), *Market IDs*, `nord.markets`
> - SDK ref: [`docs/sdk/nord-admin.md`](./docs/sdk/nord-admin.md) → *Market Management* / *Token Management* (field meanings: `sizeDecimals`, `priceDecimals`, `weightBps`, `tokenDecimals`)
> - Types: `dist/types.d.ts` (market/token/info shapes), `dist/client/Nord.d.ts`
- `registry/markets.ts`: build from `nord.getInfo()` / `nord.markets`. Provide
  `bySymbol(sym)`, `byId(id)`, `roundPrice`, `roundSize`, expose `imfBps`,
  `mmfBps`, `priceDecimals`, `sizeDecimals` (needed by risk + order rounding).
- `registry/tokens.ts`: token id ↔ symbol ↔ decimals (for deposits/withdrawals
  and balance display).
- Cache after init; refresh on demand.

**Done when:** can resolve any listed market/token and round a price/size to tick.

---

### Phase 2 — Core modules (universal, strategy-agnostic)
**Goal:** the reusable order/position/balance/account API every strategy uses.
**→ Full design & rationale in [Appendix A](#appendix-a--core-modules-phase-2-detailed-design).**

> **📖 Read first**
> - Docs: <https://docs.01.xyz/examples/> → *Trading Operations*, *Account Information*, *Deposits & Withdrawals*, *Subaccounts*
> - Docs: <https://docs.01.xyz/reference/> → *NordUser (Trading)*, REST `/account/[id]`, `/action`; *Common Errors*
> - SDK ref: [`docs/sdk/nord-user.md`](./docs/sdk/nord-user.md) → *Orders*, *Atomic Batch*, *Triggers*, *Deposits & Withdrawals*, *Subaccounts & Transfers*, *On-chain Solana Balances*, *State Fields*, *Session Management*
> - SDK ref: [`docs/sdk/nord-public-client.md`](./docs/sdk/nord-public-client.md) → *Account Queries* (`getAccountOrders`, `getAccountPnl*`, `getAccountPositionHistory`, fee helpers)
> - SDK math: `dist/mathUtils/margin.d.ts` (`calcCurrPosLiqPrice`, `calcPosMaintenanceMargin`, `getAccountMarginUsageRatio`, `getPerpsCrossMarginRatio`), `dist/mathUtils/pnl.d.ts` (`estimateClosePnl`)
> - Types: `dist/client/NordUser.d.ts`, `dist/actions.d.ts`, `dist/types.d.ts` (`Side`, `FillMode`, `TriggerKind`, `SelfTradePrevention`)

**`core/orders.ts` — OrderManager**
- `place(params)` → wraps `placeOrder`; auto-rounds price/size via registry;
  always attaches a generated `clientOrderId`; returns normalized fills/orderId.
- `cancel(orderId)` / `cancelByClientId(cid)` → wraps SDK cancels.
- `edit(orderId|cid, changes)` → modify price/size. Implement via **atomic
  cancel+place** (single engine action) to avoid a naked window.
- `get()` → current open orders from `user.orders` (+ `nord.getAccountOrders`
  for any account); `getById`.
- `cancelAll(marketId?)` → batch cancels (chunked into ≤10 atomic groups).
- Helpers: `marketBuy/marketSell` (FOK/IOC), `postOnly` quotes.

**`core/batch.ts` — AtomicBuilder**
- Fluent builder over `user.atomic([...])` enforcing the ≤10 limit and the
  per-market phase order (cancels → trades → placements). Used by `edit`,
  market maker requoting, and entry+stop combos.

**`core/positions.ts` — PositionManager**
- `list()` from `user.positions`; normalize to `{ marketId, baseSize, isLong,
  entryPrice, unrealizedPnl, fundingPnl }`.
- `liquidationPrice(marketId)` via `calcCurrPosLiqPrice` (feed it `user.margins`
  equity + other-positions MMF + live index price from `getMarketLive`).
- `closePnlEstimate(marketId)` via `estimateClosePnl` against live orderbook.
- `close(marketId, fraction?)` → reduce-only IOC/FOK order to flatten.
- History: `getAccountPnl`, `getAccountPnlSummary`, `getAccountPositionHistory`.

**`core/balances.ts` — BalanceManager**
- `exchange()` from `user.balances` (per token, per account).
- `onchain()` via `user.getSolanaBalances()`.
- `free()/used()` derivation using margins.
- Pass-throughs: `deposit`, `withdraw` (+ withdrawal fee via
  `getAccountWithdrawalFee`).

**`core/account.ts` — AccountState**
- `refresh()` → `user.fetchInfo()`; cache snapshot.
- `equity()`, `marginUsage()` (`getAccountMarginUsageRatio`),
  `crossMarginRatio()` (`getPerpsCrossMarginRatio`), `isBankrupt`.
- Subaccount helpers: `transferOwned` / `transferUnowned`.

**Done when:** an integration script can place → query → edit → cancel an order,
read positions/balances/margins, and flatten a position, all on devnet.

---

### Phase 3 — Live data feed
**Goal:** a robust streaming layer used by both the recorder and strategies.

> **📖 Read first**
> - Repo: [`scripts/ws/probe.py`](./scripts/ws/probe.py) — **authoritative** keepalive finding (lib ping killed → `ping_interval=None` + data-liveness reconnect)
> - Docs: <https://docs.01.xyz/examples/> → *Websockets*; <https://docs.01.xyz/reference/> → *WebSocket Endpoints*
> - SDK ref: [`docs/sdk/nord-public-client.md`](./docs/sdk/nord-public-client.md) → *WebSocket* (`createWebSocketClient`, `subscribeOrderbook/Trades/Bars/Account`, stream patterns), `getOrderbook`
> - SDK math: `dist/mathUtils/trading.d.ts` (`calcSlippage`) — consumes the local orderbook this phase builds
> - Types: `dist/websocket/NordWebSocketClient.d.ts`, `dist/websocket/events.d.ts` (`connected`/`disconnected`/`error`/`trade`/`delta`/`account`/`candle`/`liquidation`), `dist/websocket/Subscriber.d.ts`, `dist/types.d.ts` (`WebSocket*Update`, `CandleResolution`, `OrderbookInfo`)
- `data/feed.ts` — `LiveFeed`: thin wrapper over `nord.createWebSocketClient`
  re-emitting typed `trade`/`delta`/`candle`/`account`/`liquidation` events.
- **Resilience (from `scripts/ws/probe.py`):** disable reliance on lib ping;
  track last-message time per stream; if silent > `livenessTimeoutMs` (~15s),
  tear down and reconnect with capped exponential backoff. Emit
  `connected`/`disconnected`/`reconnecting`.
- Maintain a local **orderbook** from `delta` updates (snapshot + apply deltas);
  expose `getOrderbook(symbol)` for slippage/pnl math without REST round-trips.
- Optional REST fallback poller (`getOrderbook`, `getMarketsLive`) when WS down.

**Done when:** feed stays alive for 10+ min across forced disconnects and serves
a consistent local orderbook.

---

### Phase 4 — Recorder
**Goal:** durable capture of market microstructure for research/backtest.
**→ Full design & rationale in [Appendix B](#appendix-b--recorder-phase-4-detailed-design).**

> **📖 Read first**
> - Phase 3 `data/feed.ts` (this builds on it) + [`scripts/ws/probe.py`](./scripts/ws/probe.py)
> - Docs: <https://docs.01.xyz/examples/> → *Market Data*, *Websockets*
> - SDK ref: [`docs/sdk/nord-public-client.md`](./docs/sdk/nord-public-client.md) → *WebSocket* (`subscribeBars`, candle resolutions), *Market Data* (`getMarketsLive` for mark/funding poll), `getTrades`
> - Types: `dist/types.d.ts` (`WebSocketTradeUpdate`, `WebSocketDeltaUpdate`, `WebSocketCandleUpdate`, `OrderbookInfo`, `CandleResolution`) — basis for `schema.ts` record shapes
- `data/recorder/schema.ts` — normalized, versioned records with server +
  local timestamps: `TradeRecord`, `DeltaRecord`, `CandleRecord`,
  `BookSnapshot`, `AccountRecord`.
- `data/recorder/writers.ts` — **two-tier WAL → Parquet** sink (see
  **Appendix B** for full rationale): every tick is appended to a durable
  per-stream/per-UTC-day **JSONL WAL** (crash-safe, never buffered past the next
  flush tick), and a **compactor** folds each completed day's WAL into a
  ZSTD-compressed, dictionary/delta-encoded **Parquet** file, then verifies row
  counts and gzips/retires the WAL. Disk-minimized columnar storage *without*
  risking un-flushed ticks.
- `data/recorder/recorder.ts` — given a market set + stream set, subscribe via
  `LiveFeed`, normalize, fan out to the WAL. Records: trades, deltas (or periodic
  book snapshots), candles (`subscribeBars`/`candles`), and live mark/funding
  (`getMarketsLive` poll). Backpressure-safe; per-stream counters + heartbeat log.
- `data/recorder/compactor.ts` — daily rotation + WAL→Parquet conversion, run
  in-process after midnight rotation and as a standalone catch-up CLI.
- `data/recorder/replay.ts` — read Parquet (or un-compacted WAL) back in time
  order as a `LiveFeed`-compatible source (enables Phase 6 backtests on real data).
- `scripts/record.ts` — CLI: `--markets BTC-PERP,ETH-PERP --streams trades,deltas,candles --out ./data`.

**Done when:** `npm run record` durably writes every tick to the WAL, rotates at
UTC midnight, compacts the prior day to verified Parquet, and `replay`
reproduces the same event stream deterministically from Parquet.

---

### Phase 5 — Risk layer
**Goal:** centralized, configurable safety between strategy intent and execution.

> **📖 Read first**
> - Docs: <https://docs.01.xyz/> → *Margins* (Account Margins, Risk Framework) — defines omf/mf/imf/cmf/mmf and liquidation
> - SDK ref: [`docs/sdk/nord-user.md`](./docs/sdk/nord-user.md) → *State Fields* (`user.margins` semantics)
> - SDK math: `dist/mathUtils/margin.d.ts` (`getPositionMargin`, `getAccountMarginUsageRatio`, `getPerpsCrossMarginRatio`, `calcCurrPosLiqPrice`), `dist/mathUtils/trading.d.ts` (`calcSlippage` for entry-cost checks)
> - Types: `dist/types.d.ts` (`AccountMarginsView`)
> - Core: Phase 2 `core/account.ts` + `core/positions.ts` (guard consumes their state)
- `risk/limits.ts` — typed `RiskConfig`: max notional/position per market, max
  leverage, max total gross exposure, max open orders, daily loss limit,
  min margin buffer, per-order size cap.
- `risk/sizing.ts` — `sizeFromRisk({ riskPct, stopDistance, equity })`,
  notional→base conversion using live mark + registry decimals, leverage clamp.
- `risk/guard.ts` — `check(intent, state)` pre-trade gate returning
  allow/deny+reason. Validates against `RiskConfig`, current `margins`
  (projected post-trade margin usage via SDK margin utils), existing exposure,
  and a **kill-switch** (halts new entries, optionally flattens). Also a
  reduce-only enforcement path. All orders route through the guard.

**Done when:** guard blocks an over-leveraged / oversized order in a unit test
and sizing produces tick-valid base sizes for a given risk %.

---

### Phase 6 — Strategy framework
**Goal:** a clean contract so any strategy plugs into core modules and runs fast.

> **📖 Read first**
> - Docs: <https://docs.01.xyz/examples/> → *Initializing Nord*, *Creating a User*, *Trading Operations* (end-to-end shape the runner automates)
> - SDK ref: [`docs/sdk/nord-user.md`](./docs/sdk/nord-user.md) → *Session Management* (refresh/revoke, nonce), *State Fields*
> - Phases 2–5: `core/*`, `data/feed.ts`, `data/recorder/replay.ts`, `risk/*` — the context wires all of these
> - Types: `dist/websocket/events.d.ts` (event names the runner dispatches), `dist/types.d.ts` (update payloads passed to hooks)
- `strategy/types.ts`:
  ```ts
  interface Strategy {
    name: string;
    init(ctx: StrategyContext): Promise<void>;
    onTrade?(t: TradeUpdate, ctx: StrategyContext): Promise<void> | void;
    onBook?(book: Orderbook, ctx: StrategyContext): Promise<void> | void;
    onCandle?(c: CandleUpdate, ctx: StrategyContext): Promise<void> | void;
    onTick?(ctx: StrategyContext): Promise<void> | void;   // fixed interval
    onAccount?(u: AccountUpdate, ctx: StrategyContext): Promise<void> | void;
    shutdown?(ctx: StrategyContext): Promise<void>;
  }
  ```
- `strategy/context.ts` — `StrategyContext` bundles: `orders`, `positions`,
  `balances`, `account` (core), `feed` (book/trades), `risk` (guard+sizing),
  `registry`, `logger`, `config`, `clock`. **Every order goes through
  `risk.guard` automatically.**
- `strategy/runner.ts` — engine: starts feed + recorder(optional), refreshes
  account state, dispatches events to the strategy, runs `onTick` on an
  interval, handles errors/backoff, and on `SIGINT` runs `shutdown` →
  cancel-all → optional flatten. Supports **live** and **replay/backtest** feed
  sources behind the same context.
- `scripts/run-strategy.ts` — CLI: `--strategy market-maker --config cfg.json
  [--dry-run] [--replay ./data/...]`. `--dry-run` logs intended orders without
  sending.

**Done when:** runner can start/stop a strategy on devnet, route all orders
through risk, and cleanly flatten on shutdown.

---

### Phase 7 — Two reference strategies
**Goal:** prove the framework with two distinct, working strategies sharing core.

> **📖 Read first**
> - Docs: <https://docs.01.xyz/examples/> → *Trading Operations* (orders), and trigger usage
> - SDK ref: [`docs/sdk/nord-user.md`](./docs/sdk/nord-user.md) → *Orders* (PostOnly, `selfTradePrevention`, IOC/FOK, `isReduceOnly`), *Atomic Batch* (requote phase order), *Triggers* (SL/TP for momentum)
> - SDK ref: [`docs/sdk/nord-public-client.md`](./docs/sdk/nord-public-client.md) → *WebSocket* (`subscribeBars` for momentum candles), `getOrderbook` (mid for market-maker)
> - SDK math: `dist/mathUtils/trading.d.ts` (`calcSlippage`), `dist/mathUtils/pnl.d.ts` (`estimateClosePnl`)
> - Phase 6 `strategy/types.ts` + `strategy/context.ts` (the only surface these strategies use)

1. **`market-maker.ts`** — two-sided PostOnly quotes around mid (from local
   book), configurable spread/size/skew by inventory. Requotes via **one atomic
   cancel+place** when mid moves beyond a threshold. Inventory + max-position
   limits enforced by risk guard. Uses `selfTradePrevention`.

2. **`momentum.ts`** — candle/trend follower: subscribes to candles, computes a
   simple signal (e.g. EMA cross / breakout), sizes via `risk.sizing`, enters
   with IOC, attaches **SL/TP triggers** (`addTrigger`), manages exit via
   triggers + reduce-only close. Demonstrates the trigger + position-management
   path that market-maker doesn't.

Both ship with example config files and a `--dry-run` walkthrough.

**Done when:** both run on devnet (small size), respect risk limits, and can be
swapped via a single CLI flag — confirming "any strategy, fast, on core modules."

---

### Phase 8 — Testing, docs, hardening

> **📖 Read first**
> - Docs: <https://docs.01.xyz/> → *Common Errors*, *Changelog* (01 Exchange, N1 Engine), *Support* (FAQ: General/Trading/Troubleshooting)
> - SDK ref: [`docs/sdk/nord-user.md`](./docs/sdk/nord-user.md) → *Session Management*; [`docs/sdk/nord-public-client.md`](./docs/sdk/nord-public-client.md) → *Action Log* (`queryAction`, `getActionNonce`) for reconciliation tests
> - Types: `dist/error.d.ts` (error taxonomy to assert against)

- **Unit tests** (decimal rounding, sizing, guard, registry, schema round-trip,
  orderbook delta application) with a mocked SDK.
- **Integration tests** on devnet behind a flag (order lifecycle, flatten,
  recorder write/replay).
- **Resilience**: kill RPC/WS mid-run; verify reconnect, no duplicate/lost
  orders (idempotency via `clientOrderId`), clean shutdown.
- **Docs**: `README` quickstart, per-module usage, "writing a new strategy" guide,
  config reference, devnet→mainnet checklist.

---

## 3. Cross-cutting conventions
- **Decimals only** for money; round to tick at the edge (order placement).
- **Idempotency**: every order carries a `clientOrderId`; reconcile via
  `getAccountOrders` on reconnect.
- **Atomic-first**: prefer `user.atomic` for multi-step (edit, requote,
  entry+stop) to avoid partial states.
- **State refresh discipline**: call `fetchInfo()` on a cadence + after fills;
  never trust stale `user.*`.
- **Server time**: align scheduling to `nord.getTimestamp()` offset.
- **Fail safe**: on guard/kill-switch trip → stop entries, optionally flatten.
- **Config over code**: strategies parameterized by JSON config, no hardcoding.

## 4. Suggested milestones / order of work
1. Phase 0 + 1 (foundations + registry) — unblocks everything.
2. Phase 2 (core modules) + Phase 3 (feed) — the reusable spine.
3. Phase 4 (recorder) — start capturing data early for research.
4. Phase 5 (risk) → Phase 6 (framework) → Phase 7 (two strategies).
5. Phase 8 (tests/docs) throughout, finalized at the end.

## 5. Open questions to confirm before/while building
- Devnet vs mainnet for first live runs, and the funded test account?
- Recorder Parquet engine — **DuckDB** (best compression/ZSTD, native engine) vs
  pure-JS `parquetjs` (zero native dep, weaker compression)? See Appendix B.
- Single account or subaccount-per-strategy isolation?
- Which exact signals for the momentum strategy (EMA cross vs breakout)?
- Backtest fidelity needed — event replay only, or fill simulation against
  recorded book depth?

---

# Appendix A — Core modules (Phase 2) detailed design

## A.0 Why a manager layer at all (not raw SDK calls)
The SDK is low-level and returns raw engine shapes. Strategies must not deal with
tick rounding, nonce ordering, `Decimal` plumbing, partial-failure recovery, or
stale state. The core layer is a **thin, stateful facade** that gives every
strategy one validated, decimal-safe, idempotent API — so a new strategy is ~100
lines and can't make a class of low-level mistakes. Each module owns one concern
and is independently unit-testable against a mocked `NordUser`.

```
        Strategy  ──uses──▶  StrategyContext
                                 │
   ┌──────────────┬─────────────┼───────────────┬──────────────┐
 OrderManager  PositionMgr   BalanceMgr     AccountState   AtomicBuilder
   └──────────────┴─────────────┴───────────────┴──────────────┘
                                 │  (all writes serialized through)
                            WriteQueue (nonce-safe)
                                 │
                              NordUser  ──▶  N1 engine
```

## A.1 WriteQueue — nonce-safe action serialization (the spine)
**Problem:** every write action consumes an action **nonce** (`user.getNonce()`).
Two `placeOrder` calls fired concurrently can grab the same nonce → one is
rejected. **Decision:** all write actions (place/cancel/edit/atomic/trigger/
transfer/withdraw) funnel through a single in-process FIFO `WriteQueue` that:
- submits one action at a time, awaiting the engine ack before the next;
- on `nonce`/transient errors, refreshes nonce and retries with backoff (`utils/retry`);
- exposes `enqueue(fn): Promise<T>` so callers still get a normal awaited result.

This is why the diagram routes every manager through the queue. Reads
(`getOrderbook`, `getAccountOrders`, …) bypass it — they don't consume nonce.

## A.2 OrderManager (`core/orders.ts`)
Responsibilities: validation, tick rounding, `clientOrderId` assignment,
normalization, local order cache, reconciliation.

```ts
type PlaceIntent = {
  symbol: string;                 // resolved via registry → marketId
  side: Side;                     // Bid | Ask
  type: "limit" | "postOnly" | "ioc" | "fok" | "market"; // → FillMode
  price?: Decimal.Value;          // required unless ioc/fok/market
  size?: Decimal.Value;           // base; or…
  quoteSize?: Decimal.Value;      // …quote-denominated
  reduceOnly?: boolean;
  clientOrderId?: bigint;         // auto-generated if omitted
  stp?: SelfTradePrevention;
  accountId?: number;
};

class OrderManager {
  place(i: PlaceIntent): Promise<NormalizedOrder>   // rounds price→priceDecimals, size→sizeDecimals
  cancel(orderId: bigint, accountId?): Promise<void>
  cancelByClientId(cid: bigint, accountId?): Promise<void>
  edit(ref: bigint | {cid: bigint}, changes: {price?; size?}): Promise<NormalizedOrder> // ATOMIC cancel+place
  cancelAll(symbol?: string): Promise<void>          // chunked into ≤10 per atomic
  open(symbol?: string): NormalizedOrder[]           // from local cache (user.orders)
  getById(orderId: bigint): NormalizedOrder | null
  reconcile(): Promise<void>                         // rebuild cache from getAccountOrders
}
```

**Why these choices**
- **Always attach a `clientOrderId`** (monotonic counter seeded from server time).
  Enables `cancelByClientId` (no need to track exchange `orderId`), and
  **idempotent recovery**: after a reconnect/restart, `reconcile()` pulls live
  orders via `getAccountOrders` and matches them to intents by `clientOrderId` —
  so we never double-place or orphan an order.
- **`edit` = atomic `cancel`+`place` in one engine action** (`user.atomic`). The
  exchange has no native "modify". Doing it as two separate calls risks either a
  naked window (cancel ok, place fails → unintentionally flat) or a double
  (place ok, cancel fails → 2× exposure). Atomic makes it all-or-nothing.
- **Round at the edge** using registry `priceDecimals`/`sizeDecimals`; reject
  intents that round to zero size. Money stays `Decimal` end-to-end.
- **`type`→`FillMode` mapping** keeps strategy code intent-readable
  (`"market"`→`FillOrKill`, `"postOnly"`→`PostOnly`, etc.).

## A.3 AtomicBuilder (`core/batch.ts`)
Typed fluent wrapper over `user.atomic([...])`, enforcing the two engine rules:
≤10 subactions, and **per-market phase order cancels → trades → placements**.

```ts
new AtomicBuilder()
  .cancel(orderId)
  .place({ symbol, side, type, price, size })
  .addTrigger({ symbol, kind: TriggerKind.StopLoss, triggerPrice })
  .submit(accountId?);   // validates count + ordering, then user.atomic(...)
```
**Why:** requoting (cancel old + place new) and entry+protective-stop must be
atomic to avoid partial states; centralizing the ordering rule means callers
can't build an invalid batch.

## A.4 PositionManager (`core/positions.ts`)
Normalizes `user.positions` and layers the SDK math utils on top.

```ts
class PositionManager {
  list(): Position[]   // { symbol, baseSize, isLong, entryPrice, unrealizedPnl, fundingPnl, openOrders }
  get(symbol): Position | null
  liquidationPrice(symbol): Decimal | null   // calcCurrPosLiqPrice(...)
  closePnlEstimate(symbol): { estimatePnl; avgExitPrice; fullyFilled } // estimateClosePnl vs live book
  close(symbol, fraction = 1): Promise<void>  // reduce-only IOC to flatten
  // history pass-throughs: pnl(), pnlSummary(), positionHistory()
}
```
**Why:** liquidation price needs account equity + *other* positions' maintenance
margin + a **live index price** (`nord.getMarketLive`) — non-trivial to assemble,
so we wrap `calcCurrPosLiqPrice` once. `close()` is always **reduce-only** so it
can never accidentally flip the position.

## A.5 BalanceManager (`core/balances.ts`)
```ts
class BalanceManager {
  exchange(): TokenBalance[]                 // from user.balances
  onchain(): Promise<Record<string, number>> // user.getSolanaBalances()
  free(token): Decimal                       // exchange − margin-reserved
  deposit(p): Promise<{signature; buffer}>
  withdraw(p): Promise<{actionId}>           // + getAccountWithdrawalFee preview
}
```
**Why:** strategies size against **free** collateral, not gross balance; we
derive free/used from `user.margins`. Exchange vs on-chain are deliberately
separate methods — they answer different questions (tradeable vs wallet).

## A.6 AccountState (`core/account.ts`)
Single cached snapshot + disciplined refresh.

```ts
class AccountState {
  refresh(): Promise<void>            // user.fetchInfo() → snapshot + timestamp
  equity(): Decimal
  marginUsage(): Decimal              // getAccountMarginUsageRatio
  crossMarginRatio(): Decimal         // getPerpsCrossMarginRatio
  isBankrupt(): boolean
  ageMs(): number                     // staleness guard
  transferOwned(...) / transferUnowned(...)
}
```
**Why:** `user.*` fields are only as fresh as the last `fetchInfo()`. We refresh
on a cadence **and** immediately after any fill/own-account WS `account` update,
and expose `ageMs()` so the risk guard can refuse to trade on stale state.

## A.7 Error handling & integration test
A small `error.ts` maps engine errors (`dist/error.d.ts`) into typed categories:
`Retryable` (nonce/transient → WriteQueue retries), `Rejected` (bad params/risk →
surface to caller), `Fatal` (auth/session → stop). The Phase 2 "done" gate is one
devnet script: `place → open() → edit → cancel → positions/balances/margins →
close`, asserting each transition.

---

# Appendix B — Recorder (Phase 4) detailed design

## B.0 The core tension you asked about
Two goals fight each other:
1. **"Save every tick / don't lose data"** → needs an *append-only, immediately
   durable* format where each record is independently valid.
2. **"Parquet, minimal disk"** → Parquet is *columnar and batched*: rows are
   buffered into row groups and the file is **only readable after its footer is
   written on `close()`**. Append a single row per tick? Impossible efficiently.
   Crash before close? The whole file is **corrupt/unreadable** → you lose the
   entire segment, not just the last row.

So writing Parquet directly per tick gives you neither durability nor good
compression. **Decision: a two-tier Write-Ahead-Log (WAL) design** — the standard
way market-data recorders square this circle.

```
 tick ─▶ normalize ─▶ [Tier 1: JSONL WAL]  append+flush, crash-safe, every tick
                              │
                   UTC-midnight rotation closes the day's WAL
                              │
                      [Compactor]  read full day → sort by ts
                              │
                  [Tier 2: Parquet]  ZSTD + dict/delta encoding, tiny on disk
                              │
                   verify row counts == WAL lines
                              │
                   gzip/retire the WAL  (keep N days as safety net)
```

## B.1 Tier 1 — durable WAL (never lose a tick)
- **Format:** newline-delimited JSON (JSONL), one record per line. Every line is
  self-contained and independently parseable — a half-written final line on crash
  costs at most the last record, and is trivially detected/skipped on read.
- **Path:** `data/<env>/<stream>/<symbol>/YYYY-MM-DD.jsonl`
  (e.g. `data/devnet/trades/BTC-PERP/2026-06-15.jsonl`).
- **Durability policy (this is the "save every tick" guarantee):** records go to a
  per-file buffer that is `write()`-flushed to the OS on a **short cadence
  (≤250 ms) and on size threshold**, with an `fsync` every ~1 s. A *process*
  crash loses nothing past the last flush (sub-250 ms); only an OS/power loss can
  lose the ~1 s since the last fsync. fsync cadence is configurable down to
  per-record for the paranoid (at a throughput cost). **Append is never blocked
  by compaction** — the hot path only ever appends.
- **Why JSONL for the hot tier:** append-only, human-inspectable, recoverable
  line-by-line, zero schema-migration pain when we add fields. It is the
  *durability* layer, not the *storage* layer.

## B.2 Daily rotation
- Files are keyed by **UTC calendar day**; the writer detects the date roll on the
  first tick after midnight, closes/flushes the previous file, opens the new one.
- A timer also fires the roll exactly at 00:00 UTC even if a stream is silent, so
  empty days don't bleed into the next file.
- Rotation closing a WAL file **enqueues that file for compaction**.

## B.3 Tier 2 — Parquet compaction (minimal disk)
The compactor turns one finished day's JSONL into one Parquet file per
stream/symbol/day. Disk-minimization techniques (all lossless):
- **ZSTD compression** (level ~9–15): markedly smaller than Snappy/GZIP for this
  data.
- **Scaled-integer encoding for money:** store `price`/`size` as `int64` scaled by
  the market's `priceDecimals`/`sizeDecimals` (from the registry) instead of
  float/string. Lossless, and integers compress far better than floats.
- **Delta encoding** on monotonic columns — timestamps and `update_id`/sequence —
  so near-constant deltas pack to a few bits.
- **Dictionary encoding** on low-cardinality columns (`symbol`, `side`, `stream`).
- **Sort rows by `(ts)`** within the file to maximize run-length/delta efficiency.
- Sensible **row-group size** (e.g. ~128 MB or N rows) for good read parallelism.

Engine choice (the open question in §5):
- **DuckDB (recommended):** `COPY (SELECT … FROM read_json_auto('day.jsonl') ORDER
  BY ts) TO 'day.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`. Best ratios, column
  stats, trivial to also query the data later. Cost: a native dependency.
- **`parquetjs`/`@dsnp/parquetjs`:** pure JS, no native dep; supports
  SNAPPY/GZIP/BROTLI and row groups. Cost: weaker compression, manual encoding.

## B.4 Safety: verify-then-retire (don't break data)
Compaction is **never destructive until proven**:
1. Write `day.parquet.tmp`.
2. **Verify**: Parquet row count == WAL non-empty line count, and a checksum/last-
   timestamp match. Mismatch → keep WAL, alarm, leave Parquet as `.bad`.
3. Atomically rename `.tmp` → `.parquet`.
4. Only then **gzip the WAL** (don't delete) and keep it for a configurable
   retention window (e.g. 7 days) as a belt-and-suspenders backup before deletion.

Compaction is **idempotent and resumable**: re-running on an already-compacted day
is a no-op; a crash mid-compaction just re-runs from the intact WAL. This is why
the WAL is the source of truth and Parquet is a derived artifact.

## B.5 Record schema (`schema.ts`)
Versioned (`v` field) so format changes stay readable. Common envelope on every
record: `{ v, stream, symbol, marketId, tsServer, tsLocal }` plus per-type fields:
- `TradeRecord`: `price, size, side, tradeId, takerSide`
- `DeltaRecord`: `updateId, bids[], asks[]` (price/size pairs) — or periodic
  `BookSnapshot` (full top-N) at a configurable interval as resync anchors.
- `CandleRecord`: `resolution, open, high, low, close, volume, openTime`
- `MarkRecord`: `markPrice, fundingRate, openInterest` (from `getMarketsLive` poll)
- `AccountRecord` (optional, own account): margins/positions snapshots.

Dual timestamps (`tsServer` from the engine, `tsLocal` capture time) let us
measure feed latency and order events deterministically on replay.

## B.6 Replay (`replay.ts`)
Reads Parquet (preferred) or an un-compacted WAL, merges multiple streams by
`tsServer`, and emits the **same event interface as `LiveFeed`** — so a Phase 6
strategy runs identically on live or recorded data. Optional speed multiplier
(1×, 10×, max). This is what makes the recorder pay for itself: real-data backtests
with zero strategy code changes.

## B.7 Backpressure & resilience
- The hot path is append-only and O(1); compaction runs off-thread (separate tick
  / `setImmediate` batches or a child process) so it never stalls ingestion.
- Per-stream counters + a heartbeat log (records/sec, bytes, last-ts) surface
  silent feeds early — tied into the Phase 3 liveness/reconnect logic from
  `scripts/ws/probe.py`.
- On reconnect, a fresh `BookSnapshot` is recorded so the delta stream can be
  rebuilt on replay without spanning the gap.
