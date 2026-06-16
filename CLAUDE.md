# 01_xyz — trading bot for 01 Exchange

TypeScript (ESM, run via `tsx`) on top of `@n1xyz/nord-ts`. Live trading + a
strategy framework, with an execution simulator/backtester being built out.

## Layout
- `src/core/` — SDK-backed managers: orders, positions, balances, account, queue.
  `ports.ts` defines `IOrderGateway`/`IAccount`/`IPositions`/`IBalances` so
  strategies run against either the live SDK or the sim adapters.
- `src/engine/` + `src/strategies/` — strategy framework. Strategies implement
  `Strategy` and only touch `StrategyContext`; every order is risk-checked via the
  `GuardedOrders` facade. Run live with `npm run strategy -- --config <cfg.json>`.
- `src/risk/` — pre-trade `RiskGuard`, fixed-risk sizing, limits.
- `src/data/` — live feed + recorder (parquet) + replay reader.
- **`src/sim/`** — execution simulator (matching engine). The heart of the
  backtester. **See [`src/sim/README.md`](src/sim/README.md)** for how to use it
  without reading the modules.
- **`src/backtest/`** — backtest driver, PnL engine, metrics, report formatter.
  `runBacktest()` wires sim adapters + matching engine + PnL into a StrategyContext
  identical to live. Run with `npm run backtest -- --config <cfg.json>`.
- **`research/`** — quant-ML pipeline (Python). **See [`research/README.md`](research/README.md)**
  for full usage: quick start, feature list, model format, TS API, adding features.
- **`src/research/inference/`** — TS inference adapter. `FeatureState` computes
  same 15 features from `LocalBook`; `GBDTModel` loads JSON tree models. Parity
  test (`research/tests/test_parity.py`) guarantees train/serve match.
- `docs/backtest-plan.md` — plan + status for the sim / PnL / backtest / research work.

## Recorded data
Two datasets (details in `src/sim/README.md` and the backtest plan):
- **Native 01** (canonical): `data/<env>/<stream>/<SYMBOL>/*.parquet`, this repo's
  own recorder schema, real units. Loader: `src/sim/sources/native01.ts`.
- **fuel_o2** (older B2 archive): scaled-int (1e9), signed-delta depth. Loader:
  `src/sim/sources/fuelo2.ts`.

The recorder runs on a VPS (`ssh tokyo`). **Never run sim/tests/backtests on the
VPS** (shared 1 GB recorder box) — pull data to the Mac and run locally. See the
`vps-workflow` skill.

## Commands
- `npm test` — unit tests (`src/**/*.test.ts`, node:test).
- `npm run verify:sim:01` / `npm run verify:sim` — replay real data through the sim
  and assert correctness invariants.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run strategy -- --config <cfg>` — run a strategy (live or `--replay`/`--dry-run`).
- `npm run backtest -- --config <cfg>` — run a backtest against recorded data.
- `npm run bench:backtest` — synthetic throughput benchmark (2.8M events/sec).
- `cd research && python -m scripts.build_dataset --symbol ETHUSD` — build ML dataset.
- `cd research && python -m scripts.train_model --dataset datasets/ETHUSD.parquet` — train model.
- `cd research && python -m pytest tests/ -v` — run parity tests.
