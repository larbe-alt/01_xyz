# Binance ↔ 01 Cross-Venue Plan

**Status:** Probe RUN — **Binance leads 01 for both ETH & HYPE** (see §Results).
Edge confirmed; Steps 3–4 now justified. **Last updated:** 2026-06-20
**Scope (first pass):** ETH + HYPE.

## 0. Why

01 Exchange is a **thin venue**: ETHUSD ~0.13 trades/s, HYPEUSD ~0.047 trades/s
(measured over 80h of `data/mainnet/`). Trade-flow alpha is data-starved here.
Binance ETHUSDT/HYPEUSDT are orders of magnitude more liquid and lead price
discovery. The edge for trading a small venue is **using the deep venue as the
leader** (cross-venue lead-lag, basis, follow-the-leader market making).

So Binance is not a trading venue for us — it is a **signal source**.

## 1. Key discovery (2026-06-20)

A production Binance recorder **already exists and runs** on the `tokyo` VPS,
inside a *separate* Python project `perpl` (the Perpl DEX project, unrelated to
01). Do **not** rebuild it. See `decisions.md` → "Reuse Binance recorder".

| Item | Detail |
|---|---|
| Code | `/root/perpl/recorder/binance_{main,client,schemas}.py`, `binance_config.yaml` |
| Process | `python -m recorder.binance_main` — running since 2026-06-16, watchdog + auto-restart |
| Symbols | BTCUSDT, ETHUSDT, HYPEUSDT |
| Topics | `binance_trades` (signed: `side` buy/sell from `m`), `binance_book_ticker` (best bid/ask every update) |
| Local | `/root/data/binance_futures/<topic>/<SYMBOL>/dt=YYYY-MM-DD/HH.parquet` (Hive, hourly) |
| B2 | `b2:fuel-o2-data/binance_futures/` (~2.1 GiB), via `/root/scripts/backup-binance-b2.sh` |

### Binance schema (perpl, Arrow/parquet)
- `binance_trades`: `recv_ns` (i64, local receive, **ns**), `symbol`, `trade_id`, `price` (f64), `qty` (f64), `side` (buy/sell), `at_ms` (i64, Binance event time T)
- `binance_book_ticker`: `recv_ns`, `symbol`, `update_id`, `bid`, `bid_qty`, `ask`, `ask_qty`, `at_ms`

This is **richer than 01's schema**: dual clock (`recv_ns` local + `at_ms` exchange).

## 2. The schema/clock reconciliation (the actual work)

| | 01 (`data/mainnet/`) | Binance (`data/binance/`) |
|---|---|---|
| Local-receive clock | `ts_local` (ms) | `recv_ns` (ns) |
| Source clock | `ts` (ms) | `at_ms` (ms) |
| Trade side | `bid`/`ask` | `buy`/`sell` |
| Size field | `size` | `qty` |
| Quotes | reconstruct from `delta`/`snapshot` | `book_ticker` (best bid/ask direct) |

**Alignment axis = the local-receive clock.** Both recorders run on the *same*
VPS, so `01.ts_local` (ms) and `binance.recv_ns` (ns) are the **same machine
clock** → no NTP skew between them → receive-time lead-lag is meaningful.
Reconcile units (ns→ms or ms→ns), **do not** rebuild Binance into 01's schema.

### Reference implementation already exists
`perpl/align/` does Binance↔Perpl alignment (NOT 01). Patterns to copy:
- `asof` — event-driven as-of join on `recv_ns` = the lead-lag/arb signal
- `grid` — fixed-grid resample
- `eventlog` — single interleaved event log
- VPS-safe: `threads=1` + memory cap, drops corrupt/open files, hourly chunking
- `align/io.py` absorbs symbol map + price scaling + the timeline axis

We need the equivalent wired for **01's parquet schema**.

## 2a. Where the analysis runs — ON THE VPS, in place (decision 2026-06-20)

Both venues' data already co-reside on the `tokyo` VPS:
- Binance: `/root/data/binance_futures/<topic>/<SYMBOL>/dt=.../HH.parquet`
- 01:      `/root/01_xyz/data/mainnet/<stream>/<SYMBOL>/<T-tag>.parquet`

So we read both in place and run the join on the VPS; **only small aligned outputs
(or just printed reports) leave the box** — no bulk download. This sidesteps the B2
egress cap entirely. It deviates from the "VPS = recorder only" rule, but is
acceptable *if and only if* it cannot starve the live recorder.

⚠️ **Binding constraint — RAM.** The box is 961 MB total, recorder ≈ 590 MB used,
**≈ 370 MB available**. Every query MUST be pinned like `perpl/align/run.py`:
`SET threads=1; SET memory_limit='256MB'; SET temp_directory='/root/tmp';`
`SET preserve_insertion_order=false;` and chunk by hour/day so sorts spill to disk
instead of OOM-ing. Use the **duckdb CLI** (`/usr/local/bin/duckdb`, present), not
pandas/polars full loads. CPU/disk are fine (load ~0.02, 12 G free).

## 2b. What actually ran (2026-06-20) — recorder-safe split

`available` RAM was **~297 MB** at run time (recorder grew past the 370 MB the
plan assumed), and the VPS has **no Python analysis deps** (no duckdb/polars/numpy,
system or venv). Running the full Python probe on the box was therefore unsafe —
the 01 replay holds millions of `(ts, mid)` tuples *outside* duckdb's 256 MB cap.
So we split it:
- **Heavy reduction stays on the VPS**, done with the **duckdb CLI** (no Python):
  grid-resample each Binance `book_ticker` to 100 ms buckets (`arg_max(struct, recv_ns)`
  for a coherent last quote), pinned `threads=1 / memory_limit=256MB /
  temp_directory=/root/tmp`. Output ~27–29 MB each, 31 s, recorder untouched.
- **Light analysis runs on the Mac**: pull the small grids + 01 `snapshot/delta`
  (~241 MB total, rate-limited rsync), replay + correlate locally via the new
  `--binance-grid-parquet` fast-path. **One open hourly file** (current `dt=` being
  written) breaks duckdb — bound `dt <= <yesterday>`; the 01 overlap didn't need it.

## 3. Plan (reuse, don't rebuild; analyze on VPS)

- [x] **Step 0 — Reuse recorder as-is.** No VPS code change. Verified healthy.
- [x] **Steps 1+2 — Loader + probe code written** (`research/src/binance.py`,
      `research/scripts/lead_lag_probe.py`, pushed 2026-06-20). Steps merged: the
      probe does grid-alignment in SQL (duckdb, 256MB cap, threads=1) then
      cross-correlates in one pass — no intermediate aligned parquet needed.
      Open items resolved in code: side vocab (`buy→bid`), HYPE support, VPS RAM cap.
- [x] **Probe hardened + RUN (2026-06-20).** Review found the original probe would
      give untrustworthy lags on the sparse 01 tape; fixed before running:
      dense uniform grid + forward-fill (lag↔time now valid), per-lag Pearson,
      elementwise log-returns, Hive `dt` partition pruning in the loader.
      Run used the **recorder-safe split** (see §2b): Binance reduced on the VPS
      via the duckdb CLI, analysis on the Mac via `--binance-grid-parquet`.
      ```
      # VPS (duckdb CLI): grid-resample book_ticker -> small parquet, memory-capped.
      # Mac: .venv/bin/python -m scripts.lead_lag_probe \
      #   --symbol ETHUSD --binance-symbol ETHUSDT --env mainnet \
      #   --dir-01 <pulled 01 data> \
      #   --binance-grid-parquet ETHUSDT.grid100.parquet --grid-ms 100 --max-lag-ms 1000
      ```
- [ ] **Step 3 — Productionize** as a repeatable per-day VPS script. The split is
      proven; remaining work is to schedule the duckdb-CLI reduction + asof analysis.
- [ ] **Step 4 — Features/strategies:** add Binance-derived signals (leader microprice,
      OFI, momentum; cross-venue basis vs `mark` funding) → strategy framework.

> No Mac data pull needed. If we ever want the small aligned outputs locally, those
> are KBs–few MB and fit comfortably under the B2 free egress.

## 3b. Results (2026-06-20) — Binance leads 01

74.68 h overlap (2026-06-16 → 06-19), 100 ms grid, **2.69 M** dense aligned rows
per symbol. Cross-correlation of 100 ms log-returns; `lag>0` = Binance leads.

| Symbol | Peak lag | Peak corr | corr@0ms | corr@−100ms | Read |
|---|---|---|---|---|---|
| ETHUSD  | **+100 ms** | 0.395 | 0.392 | 0.162 | Binance leads; lead is sub-grid (0–100 ms) — corr@0 ≈ corr@100 |
| HYPEUSD | **+100 ms** | 0.326 | 0.252 | 0.044 | Binance leads more cleanly; lead concentrated near +100 ms |

- **Direction is unambiguous:** the curve is strongly right-skewed for both
  (e.g. ETH +200 ms = 0.162 vs −200 ms = 0.090; HYPE +100 = 0.326 vs −100 = 0.044).
  Negative-lag (01-leads) correlations are ~noise → **01 never leads Binance.**
- **ETH:** corr@0 ≈ corr@+100 ms → true lead is **<100 ms**, unresolved at this grid.
- **HYPE:** thinner 01 book → lead is sharper and sits right at the +100 ms bucket.
- **Caveat:** 100 ms is the resolution floor. A 20 ms re-reduce would pin the
  actionable lead (how far ahead to quote). Sample is large/robust (2.69 M rows).

**Verdict:** hypothesis confirmed — there is exploitable cross-venue lead-lag.
Step 4 (Binance-leader signals, follow-the-leader MM) is justified.

## 4. Strategy families this enables
1. Cross-venue lead-lag / follow-the-leader (Binance flow → quote ahead on 01's book).
2. Basis / funding arb (01 `mark` funding vs Binance funding).
3. Microstructure MM on 01 anchored to Binance microprice (extends `microprice-mm`).

## 5. Open items / risks
- **Recorder starvation (primary risk):** VPS-side analysis must stay within
  ~370 MB RAM. Hard-cap every query (§2a). Mitigated: probe uses `memory_limit='256MB'`,
  `threads=1`, grid-resamples Binance in SQL before returning to Python.
- ~~Probe not yet run~~ — **run 2026-06-20**, edge confirmed (§3b). Steps 3–4 live.
- ~~If probe shows no edge~~ — it did: peak corr 0.40 (ETH) / 0.33 (HYPE), Binance leads.
- **Resolution floor:** 100 ms grid can't pin sub-100 ms lead; re-reduce at 20 ms next.
- ~~Side vocab mismatch (bid/ask vs buy/sell)~~ — resolved in `binance.py`.
- ~~HYPE missing from SYMBOL_MAP~~ — resolved; probe accepts any symbol as CLI arg.
