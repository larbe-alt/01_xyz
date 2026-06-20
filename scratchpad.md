# Scratchpad — working notes

## 2026-06-20 — Cross-venue lead-lag probe: what I found & how it ran

### What I found (the numbers)
74.68 h overlap (2026-06-16 → 06-19), 100 ms grid, 2.69 M dense aligned rows/symbol.
Cross-correlation of 100 ms log-returns; `lag>0` = Binance leads 01.

```
ETHUSD   peak +100 ms  corr 0.395   (corr@0ms 0.392, corr@-100ms 0.162)
HYPEUSD  peak +100 ms  corr 0.326   (corr@0ms 0.252, corr@-100ms 0.044)
```
- Both right-skewed → **Binance leads, 01 never leads** (negative lags ≈ noise).
- ETH: corr@0 ≈ corr@+100 → true lead is **sub-100 ms** (grid can't resolve).
- HYPE: lead sharper, concentrated at +100 ms (thinner 01 book lags more distinctly).

### What's used (the pipeline that produced this)
- **Binance signal source** = perpl recorder's `binance_book_ticker` on the VPS
  (dual clock recv_ns/at_ms). Aligned to 01 on the **local-receive clock**
  (`01.ts_local` ms ↔ `binance.recv_ns` ns), same machine → no NTP skew.
- **Probe** = `research/scripts/lead_lag_probe.py` (+ loader `research/src/binance.py`,
  01 replay `research/src/data.py`). 01 mid from snapshot+delta replay; Binance mid
  from book_ticker grid; dense uniform grid + forward-fill; per-lag Pearson xcorr.
- **Hardened before running** (commits 6ec3010, a7d82e2): the original sparse
  inner-join made lag↔time invalid on 01's gappy tape; also added per-lag Pearson,
  elementwise log-returns (no silent all-zeros), Hive `dt` partition pruning,
  coherent last quote via `arg_max(struct, recv_ns)`, crossed-book mid guard.

### How it ran (recorder-safe split — see decisions.md 2026-06-20)
VPS couldn't run the full probe: ~297 MB free RAM + **no duckdb/polars/numpy** on box.
1. VPS `duckdb` CLI: grid-resample book_ticker → 27–29 MB parquet (memory_limit 256MB,
   threads=1, temp_directory=/root/tmp). 31 s, recorder untouched.
2. rsync grids + 01 snapshot/delta (~241 MB, --bwlimit) → Mac.
3. Mac `.venv`: probe with `--binance-grid-parquet` fast-path.
- Gotcha: duckdb aborts on the **open current-hour file** (`dt=<today>`); bound
  `dt <= <yesterday>` (01 overlap didn't need today anyway). Confirms dt-pruning works.

### TODO / next
- [ ] Re-reduce at **20 ms grid** to pin the sub-100 ms lead (actionable for quoting).
- [ ] Measure end-to-end order latency to 01 (gates reactive vs passive — see open-questions).
- [ ] Backtest a Binance-microprice-anchored MM through `src/sim/` (net of fees).
- [ ] Push commits 6ec3010 / a7d82e2 / 254a907 (still local on main).
