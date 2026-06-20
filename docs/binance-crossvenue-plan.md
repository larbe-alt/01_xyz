# Binance ↔ 01 Cross-Venue Plan

**Status:** Planning. Recorder reused; **analysis runs VPS-side in place — no Mac
data transfer** (B2 download cap was exhausted; both venues' data already co-reside
on the VPS). **Last updated:** 2026-06-20
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

## 3. Plan (reuse, don't rebuild; analyze on VPS)

- [x] **Step 0 — Reuse recorder as-is.** No VPS code change. Verified healthy.
- [ ] **Step 1 — Alignment query (VPS).** Write a memory-capped duckdb script
      (adapt `perpl/align` asof pattern) that as-of-joins Binance `book_ticker`
      vs 01 reconstructed mid on the shared receive clock, ETH + HYPE. Runs on the
      VPS reading both trees in place; writes a small aligned parquet locally.
- [ ] **Step 2 — Lead-lag probe** (on VPS, off the small aligned output): cross-
      correlate Binance mid returns vs 01 mid returns → "does Binance lead 01, by
      how many ms?". *Deferred by user — measure later.*
- [ ] **Step 3 — Productionize** the alignment as a repeatable VPS script (per-day,
      hourly chunked) once the probe confirms edge.
- [ ] **Step 4 — Features/strategies:** add Binance-derived signals (leader microprice,
      OFI, momentum; cross-venue basis vs `mark` funding) → strategy framework.

> No Mac data pull needed. If we ever want the small aligned outputs locally, those
> are KBs–few MB and fit comfortably under the B2 free egress.

## 4. Strategy families this enables
1. Cross-venue lead-lag / follow-the-leader (Binance flow → quote ahead on 01's book).
2. Basis / funding arb (01 `mark` funding vs Binance funding).
3. Microstructure MM on 01 anchored to Binance microprice (extends `microprice-mm`).

## 5. Open items / risks
- **Recorder starvation (primary risk):** VPS-side analysis must stay within
  ~370 MB RAM. Hard-cap every query (§2a). If memory pressure ever threatens the
  recorder, fall back to waiting for B2 cap reset and pulling to Mac.
- `perpl/align` `SYMBOL_MAP` has BTC/ETH only — HYPE needs adding when we adapt it.
- 01 quotes need book reconstruction (delta/snapshot, only 5 levels); Binance gives
  best bid/ask directly — align at best-level first.
- Trade-side vocab differs (bid/ask vs buy/sell) — normalize in the loader.
