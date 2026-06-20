# Decisions

Important decisions and trade-offs. Newest first.

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
