# Minds — Research Log

Quantitative findings, the open follow-ups they spawned, and decisions still pending. Newest entry at top.

---

## 2026-06-24 — MM microstructure stats (ETHUSD, mainnet)

**Source:** `research/scripts/mm_microstructure.py`, run on VPS over recorder parquets.

**Coverage:** four 6h windows — Asia / EU / US on 2026-06-18, plus a base window ending 2026-06-19 16:21 UTC.

### Per-session numbers

| Metric                  | Asia (02-08) | EU (08-14) | US (14-20) | Base (06-19) |
| ----------------------- | -----------: | ---------: | ---------: | -----------: |
| trades                  |        2,727 |      2,345 |      5,199 |        3,323 |
| Δblock p90 @400ms (bps) |         1.74 |       1.72 |       2.31 |         1.78 |
| Δblock p99 @400ms (bps) |         3.76 |       3.75 |       5.07 |         4.42 |
| Δblock p99 @5s (bps)    |         7.99 |       7.77 |      12.83 |         9.79 |
| taker p90 (ETH)         |         0.14 |       0.17 |       0.20 |         0.13 |
| taker p99 (ETH)         |         0.58 |       1.11 |       1.50 |         1.36 |
| λ A (fills/s @ mid)     |        0.051 |      0.092 |      0.059 |        0.065 |
| λ k (per bps)           |         0.77 |       1.00 |       0.51 |         0.81 |
| 1/k (A-S half-spread)   |         1.29 |       1.00 |       1.95 |         1.24 |

### Findings

- **US session ≠ Asia/EU.** 2× the trade rate, λ-decay constant k in 2× smaller (0.51 vs 1.00). Smaller k = fills happen deeper from mid = takers chew through more levels. Adverse selection is materially heavier in US.
- **Asia ≈ EU** — statistically indistinguishable; safe to merge for calibration.
- **Old `halfSpreadBps: 15` was 6-15× over reality.** p90 @400ms ≤ 2.5 bps in every window. Realistic corridor: **2.5–3 bps** half-spread (US p90 + buffer).
- **5s p99 in US = 12.8 bps.** `requoteMs > 3000` is risky in US — quote held too long sees fat-tail moves.
- **One static `halfSpreadBps` is a compromise** across regimes. Rolling-window adaptive (Δblock-p90 over last ~30 min) strictly dominates.

### Decisions taken

- `examples/mm-devnet.config.json` updated: `halfSpreadBps: 3`, `orderSize: 0.02` (separate task).
- Adaptive half-spread shipped to `src/strategies/microprice-mm.ts` as floor-then-widen against config-static (separate task).

### Open follow-ups

- **σ of mid returns** (1s/5s/30s/60s) needed to calibrate `skewK` via the γσ²T inventory term in Avellaneda–Stoikov. Being added to the script.
- **HYPEUSD** — recorder writes it, never analysed. Same script, same windows.
- **Multi-day stability** — only 2026-06-18 split into sessions. Want 3-5 days across high/low-vol regimes before any live capital.
- **λ-fit bias** — the [0,1) bps bin holds 60-86% of fills; A and k are anchored on that bin. Fit is a first-order indicator, not gospel.

### Architecture debts surfaced (deferred — trigger = next consumer appears)

- **`SessionTracker` lifecycle belongs in the runner, not the strategy.** Today only `microprice-mm` owns one (`const tracker = new SessionTracker()`). When the second trader-strategy that wants session metrics is added, hoist tracker creation + start/finish/onAccount-fill wiring into `src/engine/runner.ts` and expose via `ctx.tracker`. Strategy keeps only its `tracker.onQuote(fair, ...)` call site. Surfaced by /simplify altitude#3 on 2026-06-24.
- **`clamp` helper inline in `microprice-mm.ts`.** Extract to `src/utils/math.ts` when a second strategy needs it. Surfaced by /simplify reuse#1 on 2026-06-24.
