# Context Summary (compressed current state)

**Updated:** 2026-06-20

## Project
Production-grade live trading bot + strategy framework for **01 Exchange** (thin
venue), with a high-fidelity sim/backtester. Built on `@n1xyz/nord-ts`. See `plan.md`
(phases 0–8) for the full build plan; `CLAUDE.md` for rules.

## Status (from memory + this session)
- ✅ Core modules, risk layer (Phase 5), strategy framework (Phase 6), recorder,
  sim/backtest, and the quant/ML research pipeline (Python train + TS inference) are
  done. (See memory index.)
- 🔭 **Current focus: cross-venue lead-lag (Binance → 01).** 01 is data-starved
  (ETHUSD ~0.13 trades/s); use Binance (deep, liquid) as a **signal source**.

## Latest result (2026-06-20) — lead-lag probe RUN, edge CONFIRMED
- **Binance leads 01 by ≤100 ms.** ETHUSD: peak +100 ms, corr 0.395. HYPEUSD:
  peak +100 ms, corr 0.326. 01 never leads (negative lags ≈ noise).
- 74.68 h overlap, 100 ms grid, 2.69 M rows/symbol. Details: `docs/binance-crossvenue-plan.md` §3b.
- Probe was hardened (review fixes) before running; ran via **recorder-safe split**
  (Binance reduced on VPS w/ duckdb CLI, analysis on Mac) — see `decisions.md`.

## Key constraints
- **Money math = `Decimal`** (never JS number). Deterministic risk/sizing/slippage.
- Never live orders without `--live` + explicit confirm.
- **VPS is memory-bound:** ~297 MB free, two live recorders; analysis on the box must
  be hard-capped (duckdb 256 MB) or moved off-box. No Python analysis deps on the VPS.

## Open questions (see `open-questions.md`)
1. **Usage model:** reactive arb vs. passive quote-ahead MM? Leaning passive.
2. **RISK — 100 ms lead may be too small for reactive arb** if our order-latency to
   01 ≥ the lead (likely; sub-100 ms for ETH). Must measure 01 latency.
3. Which Binance feature (microprice/OFI/momentum/basis)? Does it survive fees?

## Next steps
- Re-reduce probe at 20 ms grid (pin the lead). Measure 01 order latency.
- Backtest Binance-anchored MM through `src/sim/`. Productionize the per-day VPS reduce.
- Push local commits 6ec3010 / a7d82e2 / 254a907 (on `main`).
