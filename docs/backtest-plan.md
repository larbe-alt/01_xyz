# Backtest + Research Build Plan

Goal: turn the live-only strategy framework into a system where the **same strategy
code** runs identically live, in a realistic execution simulation, and against a
research pipeline that produces ML signals it can consume.

We are **not** extending the observation-only replay harness. We build a real
matching/sim engine. The recorded **parquet store + DuckDB reader** are reused for
data loading only; the dry-run no-op execution path is replaced.

Tasks: **#1 execution simulator**, **#2 PnL+metrics**, **#3 backtest driver**
(blocked by #1+#2), **#4 research pipeline (Python, parallel)**.

---

## 0. Architectural keystone: ports & adapters

Today `StrategyContext` and `StrategyRunner` depend on the **concrete** SDK-backed
managers (`OrderManager`, `AccountState`, `PositionManager`, `BalanceManager`) and
`GuardedOrders` wraps `OrderManager` directly. To run a strategy unchanged in a
backtest we swap the *implementations*, not the strategy.

**Refactor (small, backward-compatible):** extract interfaces in `src/core/ports.ts`:

- `IOrderGateway` — `place / edit / cancel / cancelByClientId / cancelAll / open / getById`
- `IAccount` — `equity() / rawMargins() / ageMs() / accountId / refresh()`
- `IPositions` — `list() / get() / close()`
- `IBalances`

The existing live managers already satisfy these (no behavior change). `GuardedOrders`
and `StrategyContext` switch to depending on the interfaces. Live wiring is untouched;
the backtest wiring injects sim adapters. This is the only change to existing code and
the main review-risk point — kept additive.

```
                 ┌────────────── StrategyContext (unchanged surface) ──────────────┐
   Strategy ───▶ │ orders(GuardedOrders) · positions · balances · account · feed   │
                 └─────────────────────────────────────────────────────────────────┘
                          │ ports (IOrderGateway / IAccount / IPositions / IBalances)
            ┌─────────────┴──────────────┐
       LIVE │                            │ BACKTEST
   OrderManager+AccountState+…    SimOrderGateway+SimAccount+SimPositions+SimBalances
        (SDK / WS)                        (driven by SimMatchingEngine)
```

---

## Task #1 — Production-level execution simulator  (`src/sim/`)

The heart of the system. Consumes recorded market events, maintains market state, and
matches the strategy's orders against it with realistic microstructure.

**Files**
- `clock.ts` — virtual event clock (`now()` = current event ts); drives simulated `onTick`.
- `book.ts` — shared L2 book + reconstruction (extract the snapshot/delta helpers
  currently duplicated in `feed-source.ts`; reuse for both replay and sim).
- `market.ts` — `SimMarket`: per-symbol book + last trade price + mark/index + funding
  rate, updated from `trade / delta / snapshot / mark` records.
- `matching.ts` — `SimMatchingEngine` (below).
- `fees.ts` — maker/taker fee tiers (bps), funding accrual.
- `feed.ts` — `SimFeedSource implements FeedSource`: emits the same normalized
  `trade/book/candle` events strategies already handle.
- `adapters.ts` — `SimOrderGateway`/`SimAccount`/`SimPositions`/`SimBalances` over the
  engine; return `PlaceResult`-shaped objects so strategies see identical results.

**Matching model**
- **Taker** (market / IOC / FOK / marketable limit): walk real L2 depth → VWAP fill,
  depth-based slippage, partial fill / FOK-kill semantics, taker fee.
- **Maker** (resting limit / postOnly): order joins **back of queue** at its price level.
  Fills via a **trade-through model** — when recorded trades print at/through the price,
  cumulative traded volume first burns the queue ahead, then fills our order. Maker fee/rebate.
- **postOnly** rejected if it would cross; **reduceOnly** clamped to position size.
- **Latency model**: configurable submit/ack latency; orders aren't matchable until
  ack time, so they can't fill on data they shouldn't have seen (no look-ahead).
- **edit** = cancel+replace → loses queue priority (matches live).
- Emits `Fill { symbol, side, price, size, fee, liquidity: maker|taker, ts, cid }`.

**Realism levers (config):** fee bps, slippage from real depth, queue model
(optimistic↔pessimistic), latency ms, funding interval. The queue/fill heuristics are
the seam where research **#4 fill-modeling** later plugs in a learned fill-probability model.

---

## Task #2 — PnL + metrics  (`src/backtest/pnl.ts`, `metrics.ts`, `report.ts`)  ✅

- **PnLEngine** (`pnl.ts`): wraps SimState, records equity curve (sampled on every
  fill + mark), trade log with per-fill realized PnL + slippage attribution (fill
  price vs. mid), funding log (`onFunding()`), exposure tracking.
- **computeMetrics** (`metrics.ts`): pure function over equity curve + trades →
  `FullReport` with aggregate metrics + per-symbol breakdown.
  - Return: total return, CAGR
  - Risk-adjusted: Sharpe, Sortino, Calmar, Omega
  - Drawdown: max drawdown (fraction), max drawdown duration
  - Trade-level: win rate, profit factor, avg win/loss, trade count
  - Costs: fees, fee drag, funding PnL, slippage (total + avg bps)
  - Operational: max position, exposure %, turnover
  - Per-symbol: trades, realized PnL, fees, funding, slippage, win rate, PF, max pos
- **Reporters** (`report.ts`): console summary table + `toJSON()` (Infinity-safe).

All pure functions — no live dependency. 13 tests covering PnL attribution, slippage,
funding, drawdown, ratio metrics, per-symbol breakdown, and report formatting.

---

## Task #3 — Backtest driver  (`src/backtest/runner.ts`, `config.ts`, `feed.ts`; `src/scripts/backtest.ts`)  ✅

- **`runBacktest(config, events, strategy)`** (`runner.ts`): wires `SimFeedSource` +
  `MatchingEngine` + sim adapters + `PnLEngine` into the **same `StrategyContext`**.
  Strategy code is byte-for-byte identical to live.
- **`loadBacktestData(config)`**: loads native01 parquet data per market via DuckDB,
  merges into a single time-ordered `BacktestEvent[]` stream. Optional `from`/`to` filters.
- **Event loop**: for each event — update sim book + feed book → settle maker fills via
  `engine.onTrade()` BEFORE strategy sees the event (no look-ahead) → `pnl.onMark()` →
  strategy hooks. Virtual-clock `onTick` at configurable cadence between events.
- **`SimFeedSource`** (`feed.ts`): implements `FeedSource` for the backtest. Maintains
  `LocalBook`s from snapshot/delta events. Provides `getBook/getMid/getBestBid/getBestAsk`
  for the risk guard and strategy.
- **`SimOrderGateway.setFillHandler()`**: routes taker fills through `PnLEngine.onFills()`
  so both taker and maker fills are recorded with slippage attribution. Backward-compatible
  (existing tests don't set a handler and use the direct `state.applyFills()` path).
- **`initMarketsOffline(metas)`**: populates market registry without the SDK, so the risk
  guard's `bySymbol()` calls work in backtest.
- **BacktestConfig**: `{ strategy, markets, data: {dir, env, from?, to?}, risk, params,
  initialEquity, fees?, tickMs? }`.
- **CLI**: `npm run backtest -- --config cfg.json`. Writes `results/bt_<ts>/report.json`
  + `config.json`.
- **Sweep + walk-forward**: deferred to M5.

  9 runner tests: noop, taker PnL, onBook, onTick cadence, virtual clock, shutdown,
  error resilience, multi-market, empty-events rejection. 56/56 tests total.

---

## Task #4 — Research pipeline (Python, parallel)  (`research/`, `src/research/inference/`)  ✅

Reads the **same parquet store** (duckdb/polars). Python for training; export artifacts;
thin TS adapter for live inference.

- **Feature spec** (`research/spec/features.json`): 15 features across 3 categories
  (microstructure, trade flow, volatility) + 4 label definitions. Machine-readable,
  read by both Python training and TS inference.
- **Python pipeline** (`research/src/`):
  - `data.py` — parquet loader, BookState reconstructor, TradeWindow, MidHistory
  - `features.py` — 15 feature functions matching the spec
  - `labels.py` — forward-return labels via polars asof-join
  - `dataset.py` — orchestrates load → replay → features → labels at configurable sample rate
  - `train.py` — time-split (with purge gap), LightGBM training, custom JSON tree export
  - CLI: `python -m scripts.build_dataset`, `python -m scripts.train_model`
- **TS inference** (`src/research/inference/`):
  - `features.ts` — `FeatureState` class computes same 15 features from `LocalBook`
  - `model.ts` — `GBDTModel` loads JSON tree format, evaluates ensemble in pure TS
  - `index.ts` — public API for strategies: `FeatureState`, `loadModel`, `FEATURE_NAMES`
- **Parity test** (`research/tests/test_parity.py`): computes features on same synthetic
  input in both Python and TS, asserts all 15 values match within 1e-12. **Passes.**
- **Labels**: short-horizon mid-return (1s/5s/30s) + classification (sign of 5s return).
  MM/fill-modeling/regime labels deferred to first strategy integration.
- **Model export**: custom flat-node JSON tree format — no ONNX dependency. TS evaluator
  walks the tree array (split: `feature[f] <= t ? left : right`; leaf: return value).

---

## Sequencing & milestones

1. **M0 — ports refactor** ✅: `core/ports.ts` with `IOrderGateway`/`IAccount`/
   `IPositions`/`IBalances`. GuardedOrders + StrategyContext use interfaces.
   Live unchanged & green (34/34 tests pass).
2. **M1 — #1 sim adapters** ✅: `sim/adapters.ts` — `SimState` (position tracking,
   realized/unrealized PnL, equity), `SimOrderGateway` (routes orders to per-market
   engines), `SimAccount`, `SimPositions`, `SimBalances`. 19 adapter-specific tests +
   15 engine tests, all green. A strategy can now place orders through the sim and see
   positions/equity move. (#4 dataset/feature work can start now.)
3. **M2 — #2 PnL+metrics** ✅: `PnLEngine` wraps SimState, records equity curve +
   trade log + funding. `computeMetrics()` → Sharpe/Sortino/Calmar/Omega, drawdown,
   trade-level, slippage attribution, per-symbol breakdown. 13 tests.
4. **M3 — #1 maker model**: queue/trade-through fills, latency, fees, funding.
   (Already implemented in M0 engine; verified against real data.)
5. **M4 — #3 driver + CLI** ✅: `runBacktest()` + `loadBacktestData()` +
   `SimFeedSource` + `initMarketsOffline()` + `SimOrderGateway.setFillHandler()`.
   CLI: `npm run backtest -- --config cfg.json`. 9 runner tests, 56/56 total.
6. **M5 — #4 research pipeline** ✅: feature spec (15 features, 4 labels),
   Python pipeline (data/features/labels/train/export), TS inference adapter
   (`FeatureState` + `GBDTModel`), parity test (all 15 features match exactly).
   56/56 TS tests + 2/2 parity tests green.
7. **M6 — #3 sweep + walk-forward**; first trained signal validated via backtester.

**Validation:** the `noop` strategy must run identically live and in backtest; a simple
known strategy (e.g. always-cross then close) must produce hand-checkable PnL = sum of
fills − fees. Strategy code never changes between modes — that's the success criterion.

---

## Verification — built first, against real recorded data  ✅ (initial slice done)

We proved the matching semantics *before* wiring the full engine, with two layers:

### Real data source — TWO datasets, know the difference
The VPS (`ssh tokyo`) runs several recorders. For backtesting **our** 01 strategies the
authoritative source is **this repo's own recorder** (`recorder01`, cwd `/root/01_xyz`),
writing `data/<env>/<stream>/<SYMBOL>/*.parquet` in the schema of
`src/data/recorder/schema.ts`. Markets today: **ETHUSD, HYPEUSD** (mainnet). Values are in
**real units** (no scaling), trade `side` is bid/ask, book levels are JSON `[[price,size],…]`,
and **delta rows carry ABSOLUTE size per level** (0 = remove) — same as the live LocalBook.
Loader: `src/sim/sources/native01.ts`. Pull a slice (small, ~9 MB/market for 6 h):
`rsync -az tokyo:/root/01_xyz/data/mainnet/{snapshot,delta,trade}/ETHUSD data/mainnet/<stream>/`.

A second, **older/related** dataset exists in B2 (`b2:fuel-o2-data`, project `fuel_o2`): a
flat `<date>_<stream>_<MARKET>.parquet` layout with **scaled-int (1e9)** VARCHAR prices and
**signed-delta** depth. Loader: `src/sim/sources/fuelo2.ts`. Useful as extra history and for
reference feeds (`binance_*`), and `fuel_o2_trades` carries `maker_order_id`/`taker_order_id`
(future queue/fill modeling) — but the native 01 recorder above is the canonical execution data.

> ⚠ Operational guardrail (`vps-workflow` skill): the VPS is a shared 1 GB recorder box.
> Never run the sim/tests/backtests on it. Pull data to the Mac (small slices direct, or
> VPS→B2→Mac for bulk) and run locally.

### Two verification layers (both green)
1. **Unit tests** (`src/sim/*.test.ts`, `npm test`) — synthetic fixtures asserting every
   semantic: taker VWAP/depth-slippage, FOK kill, IOC partial, postOnly reject, marketable-
   limit split, back-of-queue trade-through, no-look-ahead ordering, reduceOnly clamp, FIFO,
   fees. **15/15 pass.**
2. **Real-data integration**, gating on 5 correctness invariants — book never crossed, mid in
   sane band, fills priced at/through the print, queue conservation (fill ≤ print), no
   look-ahead:
   - `npm run verify:sim:01` (native 01) — **ETHUSD** (400 snaps / 209k deltas / 2,440 trades,
     mid 1761–1838) and **HYPEUSD** (mid 72.5–76.9): all invariants hold.
   - `npm run verify:sim` (fuel_o2) — USDT-USDC (415k deltas) & FUEL-USDC: all invariants hold.
   (Whether the maker *fills* is liquidity-dependent coverage, not a correctness gate.)

These tests are the executable spec the full engine (adapters, PnL, runner) must keep green
as it's built out — M1–M2 plug PnL onto these same fills; the invariants never regress.
