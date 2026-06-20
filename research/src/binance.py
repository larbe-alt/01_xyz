"""
Binance parquet loader — reads the perpl recorder's output.

Layout on disk (Hive-partitioned, hourly):
  /root/data/binance_futures/binance_trades/<SYMBOL>/dt=YYYY-MM-DD/HH.parquet
  /root/data/binance_futures/binance_book_ticker/<SYMBOL>/dt=YYYY-MM-DD/HH.parquet

Schema (perpl Arrow/parquet):
  binance_trades:      recv_ns (i64), symbol, trade_id, price (f64), qty (f64),
                       side ("buy"/"sell"), at_ms (i64)
  binance_book_ticker: recv_ns (i64), symbol, update_id, bid (f64), bid_qty (f64),
                       ask (f64), ask_qty (f64), at_ms (i64)

Normalisation applied here (not at the analysis layer):
  - recv_ns  → recv_ms  (i64, ns ÷ 1_000_000)  — aligns with 01's ts_local (ms)
  - side "buy" → "bid", "sell" → "ask"          — aligns with 01's trade side vocab
  - qty kept as-is (caller can rename to size if needed)

VPS note: The full book_ticker stream is ~500 MB/day. Never load it raw into Python
on the VPS (only ~370 MB free). Use load_book_ticker_grid() which downsamples in SQL.
"""

import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb
import polars as pl

# VPS paths — perpl recorder writes here directly (no data/ sub-prefix)
VPS_BINANCE_ROOT = "/root/data/binance_futures"

_SYMBOL_RE = re.compile(r"^[A-Z0-9]+$")


def _safe_symbol(symbol: str) -> str:
    """Reject anything that isn't a plain market symbol before it reaches SQL/globs."""
    s = str(symbol).upper()
    if not _SYMBOL_RE.match(s):
        raise ValueError(f"Unsafe/invalid symbol: {symbol!r}")
    return s


def _glob(data_dir: str | Path, topic: str, symbol: str) -> str:
    """Return a DuckDB-compatible glob for a Hive-partitioned topic/symbol."""
    p = Path(data_dir) / topic / _safe_symbol(symbol)
    return str(p / "**" / "*.parquet")


def _dt_bounds(from_ms: int | None, to_ms: int | None) -> tuple[str | None, str | None]:
    """Map a recv-ms window to padded Hive `dt` date-string bounds (±1 day).

    The ±1-day pad absorbs any timezone / recv-vs-event partitioning skew so we
    never prune away a partition that holds in-range rows.
    """
    lo = hi = None
    if from_ms is not None:
        lo = (datetime.fromtimestamp(from_ms / 1000, tz=timezone.utc).date()
              - timedelta(days=1)).isoformat()
    if to_ms is not None:
        hi = (datetime.fromtimestamp(to_ms / 1000, tz=timezone.utc).date()
              + timedelta(days=1)).isoformat()
    return lo, hi


def _where(from_ms: int | None, to_ms: int | None) -> str:
    """Build a WHERE that prunes on the Hive `dt` partition first (sargable, so
    unmatched files are skipped before any row is read), then trims intra-day on
    the computed recv_ms. Without the `dt` clauses DuckDB would scan the whole
    history every call — the recorder-starvation risk flagged in the plan."""
    clauses: list[str] = []
    lo, hi = _dt_bounds(from_ms, to_ms)
    if lo is not None:
        clauses.append(f"dt >= '{lo}'")
    if hi is not None:
        clauses.append(f"dt <= '{hi}'")
    if from_ms is not None:
        clauses.append(f"(recv_ns // 1000000) >= {int(from_ms)}")
    if to_ms is not None:
        clauses.append(f"(recv_ns // 1000000) <= {int(to_ms)}")
    return ("WHERE " + " AND ".join(clauses)) if clauses else ""


def _make_con(memory_limit: str = "256MB", temp_dir: str | None = None) -> duckdb.DuckDBPyConnection:
    # Plan/decisions mandate /root/tmp (disk-backed, 12G free) so sorts spill to
    # disk, not RAM-backed tmpfs. Fall back to the system temp off-VPS (Mac).
    if temp_dir is None:
        temp_dir = "/root/tmp" if Path("/root/tmp").is_dir() else tempfile.gettempdir()
    con = duckdb.connect()
    con.execute(f"""
        SET threads=1;
        SET memory_limit='{memory_limit}';
        SET temp_directory='{temp_dir}';
        SET preserve_insertion_order=false;
    """)
    return con


def load_book_ticker_grid(
    data_dir: str | Path,
    symbol: str,
    grid_ms: int = 100,
    from_ms: int | None = None,
    to_ms: int | None = None,
) -> pl.DataFrame:
    """
    Load Binance best-bid/ask, grid-resampled IN SQL (last-value per bucket).

    Returns columns: recv_ms (bucket START, quantized to grid_ms), bid, ask, mid,
    last_recv_ms (true ms of the last quote in the bucket — its freshness).
    `mid` is NULL when the last quote is crossed (bid > ask) or one-sided.
    Safe on the VPS: only the downsampled result leaves duckdb (<<10 MB), and the
    scan is pruned to the relevant `dt=` partitions (see _where).
    """
    g = _glob(data_dir, "binance_book_ticker", symbol)
    grid_ms = int(grid_ms)
    where = _where(from_ms, to_ms)

    con = _make_con()
    try:
        df = con.execute(f"""
            WITH raw AS (
                SELECT
                    recv_ns,
                    ((recv_ns // 1000000) // {grid_ms} * {grid_ms})::BIGINT AS bucket_ms,
                    bid::DOUBLE  AS bid,
                    ask::DOUBLE  AS ask
                FROM read_parquet('{g}', hive_partitioning=true)
                {where}
            ),
            bucketed AS (
                -- Pick bid AND ask from the SAME last row (max recv_ns) so the
                -- quote is coherent; recv_ns (ns) breaks within-ms ties exactly.
                SELECT
                    bucket_ms,
                    arg_max(struct_pack(bid := bid, ask := ask), recv_ns) AS q,
                    (max(recv_ns) // 1000000)::BIGINT                     AS last_recv_ms
                FROM raw
                GROUP BY bucket_ms
            )
            SELECT
                bucket_ms     AS recv_ms,
                q.bid         AS bid,
                q.ask         AS ask,
                CASE WHEN q.bid IS NOT NULL AND q.ask IS NOT NULL AND q.ask >= q.bid
                     THEN (q.bid + q.ask) / 2.0 END AS mid,
                last_recv_ms
            FROM bucketed
            ORDER BY bucket_ms
        """).pl()
    finally:
        con.close()

    return df


def load_trades(
    data_dir: str | Path,
    symbol: str,
    from_ms: int | None = None,
    to_ms: int | None = None,
) -> pl.DataFrame:
    """
    Load Binance trade tape.

    Returns columns: recv_ms, at_ms, trade_id, price, qty, side ("bid"/"ask")
    Sorted by recv_ms ascending.

    VPS note: Binance trades are ~200 MB/day. A time window is REQUIRED — without
    it the `ORDER BY recv_ns` sort scans+spills the full history and can starve the
    live recorder. Chunk by day on the VPS.
    """
    if from_ms is None and to_ms is None:
        raise ValueError(
            "load_trades requires from_ms and/or to_ms — an unbounded scan+sort "
            "is unsafe on the VPS (would starve the recorder)."
        )
    g = _glob(data_dir, "binance_trades", symbol)
    where = _where(from_ms, to_ms)

    con = _make_con()
    try:
        df = con.execute(f"""
            SELECT
                (recv_ns // 1000000)::BIGINT  AS recv_ms,
                at_ms::BIGINT                 AS at_ms,
                trade_id,
                price::DOUBLE                 AS price,
                qty::DOUBLE                   AS qty,
                side
            FROM read_parquet('{g}', hive_partitioning=true)
            {where}
            ORDER BY recv_ns
        """).pl()
    finally:
        con.close()

    df = df.with_columns(
        pl.col("side").replace({"buy": "bid", "sell": "ask"}).alias("side")
    )
    return df
