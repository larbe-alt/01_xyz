# Minds — Research Log

Quantitative findings, the open follow-ups they spawned, and decisions still pending. Newest entry at top.

---

## 2026-06-25 — MM microstructure: ETH vs HYPE side-by-side

**Source:** same `research/scripts/mm_microstructure.py`, same 4 windows
(Asia/EU/US 2026-06-18, base = last 6h ending 2026-06-19 16:20 UTC). ETH was
re-run today because the original 2026-06-24 table predates the σ-mid-returns
section. Raw JSONs: `research/output/mm_eth_2026-06-18/` and `mm_hype_2026-06-18/`.

### US session (the worst case — anchor for static floor)

| Metric                    |  ETH US |  HYPE US | HYPE / ETH |
| ------------------------- | ------: | -------: | ---------: |
| trades (6 h)              |   5,199 |    1,406 |       0.27 |
| Δblock p90 @ 400ms (bps)  |    2.31 |     4.12 |      1.78× |
| Δblock p99 @ 5s (bps)     |   12.83 |    20.18 |      1.57× |
| λ k (per bps)             |    0.51 |     0.33 |      0.64× |
| 1/k (A-S half-spread, bps)|    1.95 |     3.05 |      1.56× |
| σ 60s (bps / √sec)        |    1.55 |     2.77 |      1.79× |
| taker p90 (base)          |    0.20 |     2.03 |        n/a |

### σ mid-returns by horizon (bps / √sec — Sharpe-friendly form)

|        | 1s   | 5s   | 30s  | 60s  |
| ------ | ---- | ---- | ---- | ---- |
| ETH US | 2.04 | 1.74 | 1.62 | 1.55 |
| HYPE US| 3.30 | 2.93 | 2.83 | 2.77 |

Per-√sec σ is roughly flat across horizons within each market → no obvious
mean-reversion structure inside the 1-60s window. **HYPE σ is ~1.8× ETH σ.**

### Findings

- **HYPE is structurally ~1.6-1.8× wider than ETH** on Δblock-p90, σ, and 1/k.
  Conclusions transfer: same regime ordering (US > Asia ≈ EU), but every number
  scales up.
- **Adverse selection is materially heavier on HYPE.** k = 0.27-0.37 vs ETH
  0.51-1.00 → fills happen *deeper* from mid; takers chew through more levels.
- **HYPE fill rate is 5-10× lower** (λ A = 0.004-0.016 vs 0.05-0.09). Less to
  capture per unit time, but each fill costs more.
- **Old `halfSpreadBps: 15` was 5-10× over HYPE reality too** (US p90 = 4.1).
- **`requoteMs > 3s` is risky in US** for both markets (HYPE US 5s p99 = 20 bps,
  ETH 13 bps).

### Calibration corridor (US-anchored static floor; adaptive widens above)

| Param                | ETH   | HYPE  | Reasoning |
| -------------------- | ----- | ----- | --------- |
| `halfSpreadBps`      | 3     | 4.5   | max(US Δblock-p90) + ~0.5 bps buffer |
| `skewK`              | 0.5   | 0.7   | scale with σ-ratio; HYPE wants stronger inventory pull |
| `orderSize` (base)   | 0.02  | 2.0   | ~$70 / ~$50 notional; both ≫ min size, ≤ HYPE p90 taker |
| `requoteMs` (ms)     | 2000  | 2000  | both markets US 5s p99 > 12 bps → don't sit > 3s |
| `imbDepth`           | 5     | 5     | default; revisit when imbalance backtest exists |

### Open follow-ups

- **σ²T → `skewK` derivation is still rule-of-thumb.** Avellaneda–Stoikov asks
  for `γσ²T` (γ = risk aversion, T = liquidation horizon). Without a fitted γ
  we picked skewK qualitatively (HYPE 1.4× ETH ≈ σ-ratio). Real derivation
  needs a position-PnL backtest to fit γ. Track in `open-questions.md`.
- **Multi-day stability** — still only one calendar day analysed per market.
  **Blocked** by stopped recorder (see `open-questions.md` 2026-06-25 entry).
- **λ-fit bias for HYPE** — [0, 1) bps bin holds the bulk of fills here too,
  and the absolute fill count is small (~25-50 fills total in the fit). Treat
  k as directional, not gospel; 1/k is a sanity rail, not a target.

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
