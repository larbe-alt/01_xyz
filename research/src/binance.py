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

from pathlib import Path

import duckdb
import polars as pl

# VPS paths — perpl recorder writes here directly (no data/ sub-prefix)
VPS_BINANCE_ROOT = "/root/data/binance_futures"


def _glob(data_dir: str | Path, topic: str, symbol: str) -> str:
    """Return a DuckDB-compatible glob for a Hive-partitioned topic/symbol."""
    p = Path(data_dir) / topic / symbol
    return str(p / "**" / "*.parquet")


def _make_con(memory_limit: str = "256MB") -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(f"""
        SET threads=1;
        SET memory_limit='{memory_limit}';
        SET temp_directory='/tmp';
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

    Returns columns: recv_ms (bucket), bid, ask, mid — one row per grid_ms bucket.
    Safe on the VPS: only the downsampled result leaves duckdb (<<10 MB).
    """
    g = _glob(data_dir, "binance_book_ticker", symbol)
    where = ""
    clauses = []
    if from_ms is not None:
        clauses.append(f"(recv_ns // 1000000) >= {from_ms}")
    if to_ms is not None:
        clauses.append(f"(recv_ns // 1000000) <= {to_ms}")
    if clauses:
        where = "WHERE " + " AND ".join(clauses)

    con = _make_con()
    try:
        df = con.execute(f"""
            WITH raw AS (
                SELECT
                    (recv_ns // 1000000)::BIGINT           AS recv_ms,
                    ((recv_ns // 1000000) // {grid_ms} * {grid_ms})::BIGINT AS bucket_ms,
                    bid::DOUBLE  AS bid,
                    ask::DOUBLE  AS ask
                FROM read_parquet('{g}', hive_partitioning=true)
                {where}
            ),
            bucketed AS (
                SELECT
                    bucket_ms,
                    LAST(bid  ORDER BY recv_ms) AS bid,
                    LAST(ask  ORDER BY recv_ms) AS ask
                FROM raw
                GROUP BY bucket_ms
            )
            SELECT
                bucket_ms                  AS recv_ms,
                bid,
                ask,
                (bid + ask) / 2.0          AS mid
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

    VPS note: Binance trades are ~200 MB/day. Filter with from_ms/to_ms to keep
    daily chunks; do not load the full history in one call on the VPS.
    """
    g = _glob(data_dir, "binance_trades", symbol)
    where = ""
    clauses = []
    if from_ms is not None:
        clauses.append(f"(recv_ns // 1000000) >= {from_ms}")
    if to_ms is not None:
        clauses.append(f"(recv_ns // 1000000) <= {to_ms}")
    if clauses:
        where = "WHERE " + " AND ".join(clauses)

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
