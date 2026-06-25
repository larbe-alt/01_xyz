# Decisions

Important decisions and trade-offs. Newest first.

## 2026-06-25 — MM: per-market config files, separate processes

**Context:** Microstructure calibration (`minds.md` 2026-06-25) shows HYPE is
structurally 1.6–1.8× wider/more volatile than ETH; a single `halfSpreadBps` /
`skewK` / `orderSize` across both markets is a strict pessimisation of one or
the other. Strategy supports multi-market in one process, but params are global.

**Decision:** Split MM into two **separate config files** (`examples/mm-eth.config.json`,
`examples/mm-hype.config.json`), each running as its own process. No code
change to `microprice-mm.ts` needed — single-market `run.markets` keeps the
existing `ctx.params` global, which is fine when there's only one market.

**Trade-off accepted:** two processes share one 01 account → margin, equity,
and the `maxDailyLossUsdc` kill-switch are **per-process**, not global. To
avoid combined exposure blowing past intent:
- `maxTotalGrossNotional`: halved per config (500 each, was 1000 shared).
- `maxDailyLossUsdc`: halved per config (10 each, was 20 shared).
- `maxLeverage`/`minMarginBufferPct` unchanged — those compose safely (each
  process's IMF check sees the combined account state from `fetchInfo`).

**If we put real capital on it**, revisit: either (a) lift `paramsByMarket`
into the strategy so one process covers both (cleaner risk accounting), or
(b) add a tiny external watchdog that monitors combined PnL and trips both
processes via a shared kill-flag. Option (a) is the lower-magic path.

**Calibrated values (US-anchored, from `minds.md` 2026-06-25):**

| param           | ETH  | HYPE |
| --------------- | ---- | ---- |
| halfSpreadBps   | 3    | 4.5  |
| skewK           | 0.5  | 0.7  |
| orderSize       | 0.02 | 2.0  |
| maxPositionBase | 0.1  | 15   |

Both start `dryRun: true`. `mm-devnet.config.json` left untouched as the
devnet template / fixture.

## 2026-06-20 — Probe RUN: edge confirmed → greenlight Steps 3–4 (as PASSIVE signal)

**Context:** Cross-venue lead-lag probe was hardened (review fixes, commits 6ec3010 /
a7d82e2) and run. Result: **Binance leads 01 by ≤100 ms** — ETHUSD peak +100 ms
corr 0.395, HYPEUSD +100 ms corr 0.326; 01 never leads (negative lags ≈ noise).
Full results: `docs/binance-crossvenue-plan.md` §3b.

**Decision:** Proceed with Steps 3 (productionize) and 4 (Binance-leader signals),
but as a **passive / follow-the-leader market-making** signal, **not** reactive
cross-venue arbitrage.

**Why:** "Binance leads" ≠ "capturable". The lead is small (sub-100 ms for ETH).
Classic reactive arb needs end-to-end latency-to-01 < the lead; on a Solana-based
venue that's plausibly tens–hundreds of ms → the edge would be gone before our order
rests. Passive quoting (bias resting orders toward Binance microprice) collects the
drift without racing. The reactive option stays open *only if* measured 01 latency
turns out well under the lead. Tracked in `open-questions.md`.

**Consequence / how to apply:** before building, (a) measure end-to-end order latency
to 01, (b) re-reduce the probe at **20 ms grid** to pin the true lead horizon (100 ms
is a resolution floor), (c) backtest a Binance-anchored MM through `src/sim/` net of
fees. If lead < latency → passive only.

## 2026-06-20 — How cross-venue analysis actually runs: VPS-reduce + off-box analyze

**Context:** Prior decision (below) was "run the analysis ON the VPS, in place".
At run time that proved unsafe: `available` RAM was only **~297 MB** (recorder grew
past the 370 MB assumed) AND the VPS has **no Python analysis deps** (no duckdb/
polars/numpy, system or venv). The 01 replay holds millions of `(ts, mid)` tuples
*outside* duckdb's 256 MB cap.

**Decision:** Refine the rule to a **split**: do the heavy data reduction ON the VPS
with the **duckdb CLI** (no Python), pull the small reduced outputs + the small 01
`snapshot/delta` to the Mac (rate-limited rsync), and run the Python replay +
correlation **off-box**. New probe flag `--binance-grid-parquet` consumes the
pre-reduced grid.

**Why:** Keeps the memory-heavy Python off the live recorder host entirely while the
big data (Binance, ~900 MB) never leaves the VPS un-reduced. Reduction was 31 s,
~27 MB out per symbol, recorder untouched.

**Consequence / how to apply:**
- VPS reduction MUST stay pinned (`threads=1; memory_limit='256MB';
  temp_directory='/root/tmp'; preserve_insertion_order=false`) and prune on the Hive
  `dt` partition.
- **Gotcha:** duckdb aborts on the recorder's **open current-hour file**
  (`dt=<today>/HH.parquet`, no magic bytes). Bound `dt <= <yesterday>`.
- Do NOT `pip install` analysis deps onto the recorder VPS.

**Trade-off:** one ~241 MB VPS→Mac pull per run (vs. zero with pure on-VPS), accepted
for zero recorder-starvation risk. Supersedes the on-VPS-only stance below for any run
that needs the Python replay; pure-duckdb-CLI work can still stay fully on the VPS.

## 2026-06-20 — Run cross-venue analysis ON the VPS, in place (no Mac data transfer)

**Context:** Planned to pull Binance ETH+HYPE (1.4 GiB) to the Mac for alignment.
The B2 daily download cap was exhausted (free ~1 GB/day) → even single-day pulls
returned 403. Both venues' data already co-reside on the VPS.

**Decision:** Read both parquet trees in place and run the alignment/analysis **on
the VPS**; only small aligned outputs (or printed reports) leave. No bulk download.

**Why:** Sidesteps the egress cap entirely; the data is already there;
`perpl/align/run.py` already proves VPS-side alignment is feasible safely.

**Consequence / how to apply — RAM is the binding constraint:** box is 961 MB,
recorder ≈ 590 MB used, **≈ 370 MB available**. Every query MUST be pinned:
`SET threads=1; memory_limit='256MB'; temp_directory=...; preserve_insertion_order=false;`
and chunk by hour/day (spill to disk, never OOM). Use duckdb CLI
(`/usr/local/bin/duckdb`), not pandas/polars full loads. If memory pressure ever
threatens the recorder, fall back to B2-after-reset → pull to Mac.

**Trade-off accepted:** deviates from the documented "VPS = recorder only" rule, in
exchange for zero egress and immediate access. Safe *only* under the hard caps above.

## 2026-06-20 — Reuse the existing Binance recorder; do NOT rebuild

**Context:** Plan called for adding a Binance recorder (aggTrades + bookTicker for
ETHUSDT/HYPEUSDT) "into the same parquet schema as 01, time-aligned with 01's ts."
Investigation found a production Binance recorder **already running** on the `tokyo`
VPS inside the separate `perpl` project (BTC/ETH/HYPE, trades + book_ticker, on B2).

**Decision:** Reuse it as-is. Do not re-implement in TypeScript / 01's schema.

**Why:**
- It is battle-tested (watchdog, auto-restart, B2 backup) and already capturing
  exactly ETHUSDT + HYPEUSDT.
- Its schema is *better* for our purpose: dual clock `recv_ns` (ns, local) +
  `at_ms` (exchange). Rebuilding into 01's ms-only schema would **lose** the
  nanosecond receive clock — the very thing lead-lag needs.
- Rebuilding duplicates a working service and violates "Simplicity first" (Rule 2)
  and "Surgical changes" (Rule 3).

**Consequence / how to apply:**
- Schema reconciliation happens at the **analysis layer**, not the recorder.
- Alignment axis = the **local-receive clock** (`01.ts_local` ms ↔ `binance.recv_ns`
  ns). Both recorders are co-located on the same VPS → same machine clock → no NTP
  skew → receive-time lead-lag is valid.
- `perpl/align/` (asof/grid/eventlog) is the reference implementation to adapt for
  01, but it is wired to Perpl DEX, not 01 — see `docs/binance-crossvenue-plan.md`.

**Trade-off accepted:** two different parquet schemas/layouts to reconcile, vs. one
unified recorder. Worth it — the reconciliation is a small, well-understood join and
the dual-clock data is more valuable.
