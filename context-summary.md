# Context Summary (compressed current state)

**Updated:** 2026-06-25

## Project
Production-grade live trading bot + strategy framework for **01 Exchange** (thin
venue), with a high-fidelity sim/backtester. Built on `@n1xyz/nord-ts`. See `plan.md`
(phases 0–8) for the full build plan; `CLAUDE.md` for rules.

## Status
- ✅ Core modules, risk layer (Phase 5), strategy framework (Phase 6), recorder,
  sim/backtest, quant/ML research pipeline (Python train + TS inference) are done.
- ✅ **MM microstructure calibration complete** — ETH and HYPE analysed side-by-side
  across Asia/EU/US sessions (2026-06-18 data). Per-market config files shipped.
- ✅ **Recorder WS-death bug fixed** (`fix(feed): per-stream liveness watchdog`, commit
  56e76d1). Root cause: shared `lastMessageMs` let any stream tick mask silent death
  of trades/deltas. Fixed with per-stream `Map<string, number>`; only fast streams
  (trades, deltas) gate the watchdog.
- ✅ **Private Solana RPC** — `SOLANA_RPC_MAINNET` in `.env`, ~50ms init (was 5 min
  on the public endpoint).
- 🔭 **Recorder is live on mainnet** (ETHUSD + HYPEUSD, VPS tmux `recorder01`).
  Day 1 of fresh recording after a 6-day zombie gap (2026-06-19 → 2026-06-25).
- ⏳ **Waiting on 3-5 days of fresh multi-day data** before live capital on MM.

## MM calibration summary (US-anchored; from `minds.md` 2026-06-25)

| Param           | ETH (`mm-eth.config.json`) | HYPE (`mm-hype.config.json`) |
| --------------- | -------------------------: | ---------------------------: |
| halfSpreadBps   | 3                          | 4.5                          |
| skewK           | 0.5                        | 0.7                          |
| orderSize       | 0.02 ETH (~$70)            | 2.0 HYPE (~$50)              |
| maxPositionBase | 0.1                        | 15                           |
| dryRun          | true                       | true                         |

HYPE is structurally ~1.6–1.8× wider/more volatile than ETH (US Δblock-p90: 4.12
vs 2.31 bps; σ-60s: 2.77 vs 1.55 bps/√s). Two separate processes share one 01
account; risk limits halved per config (`maxTotalGrossNotional: 500`,
`maxDailyLossUsdc: 10`). Both ship `dryRun: true`; flip to `false` only after
verify-run.

## Cross-venue lead-lag (2026-06-20)
- **Binance leads 01 by ≤100 ms.** ETHUSD peak +100 ms corr 0.395; HYPEUSD +100 ms
  corr 0.326. 01 never leads.
- **Decision: passive only** — reactive arb not capturable (sub-100 ms lead, 01
  order latency likely ≥100 ms). Use Binance microprice as a passive quoting signal.
- Full results: `docs/binance-crossvenue-plan.md` §3b; decisions in `decisions.md`.

## Key constraints
- **Money math = `Decimal`** (never JS number). Deterministic risk/sizing/slippage.
- Never live orders without `--live` + explicit user confirm.
- **VPS is memory-bound:** ~297 MB free; analysis on-box must use duckdb CLI
  (256 MB cap, `threads=1`). No Python analysis deps on the VPS.
- **Data flow:** VPS → B2 → Mac. **Code flow:** Mac → git → VPS.
- **`.env` has secrets** — never commit, sandbox cannot read.

## Open questions (see `open-questions.md`)
1. **σ²T → `skewK` formal derivation** — current rule-of-thumb (HYPE 1.4× ETH ≈
   σ-ratio); needs position-PnL backtest to fit γ (risk aversion).
2. **Multi-day stability** — blocked by recorder gap until 2026-06-28+ (need 3-5 days).
3. **Operational hardening** — heartbeat alert, systemd unit, network-assert on start.
4. **Binance lead-lag follow-ups** — re-reduce at 20 ms grid, measure 01 order latency,
   backtest Binance-anchored MM through `src/sim/`.

## Next steps
1. Let recorder accumulate 3-5 days of fresh mainnet data (both symbols).
2. Re-run `mm_microstructure.py` on fresh data, compare with 2026-06-18 baseline.
3. When stable: flip `dryRun: false` and paper-trade with real quotes (no capital at risk).
4. Binance passive-signal integration into `microprice-mm.ts` (after latency is measured).
