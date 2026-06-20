"""
Cross-venue lead-lag probe: does Binance price discovery lead 01 Exchange?

Method:
  1. Build a mid-price series for 01 from snapshot+delta replay (ts_local clock).
  2. Build a grid-resampled mid series for Binance from book_ticker (recv_ms clock),
     downsampled IN SQL so only ~MBs leave duckdb (VPS-safe).
  3. Both recorders run on the same VPS → clocks are co-located → no NTP skew.
  4. Inner-join both on the shared grid, compute log-returns, cross-correlate.
  5. lag > 0 means Binance leads 01.

VPS usage (run where both data trees live):
    cd /root/01_xyz/research
    python -m scripts.lead_lag_probe \\
        --symbol ETHUSD --binance-symbol ETHUSDT \\
        --dir-01 /root/01_xyz/data --env mainnet \\
        --dir-binance /root/data/binance_futures \\
        [--grid-ms 100] [--max-lag-ms 1000]

Mac usage (on small aligned extract):
    python -m scripts.lead_lag_probe \\
        --symbol ETHUSD --binance-symbol ETHUSDT \\
        --dir-01 ../data --env mainnet \\
        --dir-binance ../data/binance
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.binance import load_book_ticker_grid
from src.data import load_events, replay_book


# ---------------------------------------------------------------------------
# 01 mid series
# ---------------------------------------------------------------------------

def _build_01_mid_series(data_dir: str, env: str, symbol: str) -> pl.DataFrame:
    """Replay 01 parquet snapshot+delta → (ts_local ms, mid) series."""
    events = load_events(data_dir, env, symbol)
    rows: list[tuple[int, float]] = []
    for book, ev in replay_book(events):
        if ev.kind in ("snapshot", "delta"):
            mid = book.mid()
            if mid is not None:
                rows.append((ev.ts, mid))
    if not rows:
        return pl.DataFrame({"recv_ms": pl.Series([], dtype=pl.Int64),
                             "mid": pl.Series([], dtype=pl.Float64)})
    return pl.DataFrame({"recv_ms": [r[0] for r in rows],
                         "mid":     [r[1] for r in rows]})


def _resample_to_grid(df: pl.DataFrame, grid_ms: int) -> pl.DataFrame:
    """Last-value grid resample. Returns columns: bucket_ms, mid."""
    df = df.with_columns(
        (pl.col("recv_ms") // grid_ms * grid_ms).alias("bucket_ms")
    )
    return (
        df.group_by("bucket_ms")
        .agg(pl.col("mid").last())
        .sort("bucket_ms")
    )


# ---------------------------------------------------------------------------
# Cross-correlation
# ---------------------------------------------------------------------------

def _log_returns(series: np.ndarray) -> np.ndarray:
    r = np.zeros_like(series)
    valid = series > 0
    if valid.all():
        r[1:] = np.log(series[1:] / series[:-1])
    return r


def _cross_correlate(x: np.ndarray, y: np.ndarray, max_lag: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Cross-correlation at lags -max_lag … +max_lag.
    lag > 0 → x leads y (x at t correlates with y at t+lag).
    """
    x = (x - x.mean()) / (x.std() + 1e-12)
    y = (y - y.mean()) / (y.std() + 1e-12)
    n = len(x)
    lags = np.arange(-max_lag, max_lag + 1)
    corrs = np.array([
        np.dot(x[:n - lag], y[lag:]) / (n - lag) if lag >= 0
        else np.dot(x[-lag:], y[:n + lag]) / (n + lag)
        for lag in lags
    ])
    return lags, corrs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Cross-venue lead-lag probe")
    parser.add_argument("--symbol",         required=True, help="01 symbol, e.g. ETHUSD")
    parser.add_argument("--binance-symbol", required=True, help="Binance symbol, e.g. ETHUSDT")
    parser.add_argument("--dir-01",      default="../data",                    help="Path to 01 data/ dir")
    parser.add_argument("--dir-binance", default="/root/data/binance_futures", help="Path to Binance data root")
    parser.add_argument("--env",         default="mainnet",  help="01 environment (mainnet/devnet)")
    parser.add_argument("--grid-ms",     type=int, default=100,  help="Resample grid in ms (default 100)")
    parser.add_argument("--max-lag-ms",  type=int, default=1000, help="Max lag to test in ms (default 1000)")
    args = parser.parse_args()

    dir_01      = str(Path(args.dir_01).resolve())
    dir_binance = str(Path(args.dir_binance).resolve())
    grid_ms     = args.grid_ms
    max_lag_steps = args.max_lag_ms // grid_ms

    # ---- 01 mid series ----
    print(f"Replaying 01 book for {args.symbol} ({args.env}) from {dir_01} ...")
    e01 = _build_01_mid_series(dir_01, args.env, args.symbol)
    if len(e01) == 0:
        print("ERROR: no 01 data found.")
        sys.exit(1)
    print(f"  {len(e01):,} updates  recv_ms [{e01['recv_ms'].min()} … {e01['recv_ms'].max()}]")

    t_01_start = int(e01["recv_ms"].min())
    t_01_end   = int(e01["recv_ms"].max())

    # ---- Binance mid series (grid-resampled in SQL) ----
    print(f"Loading Binance book_ticker grid ({grid_ms}ms) for {args.binance_symbol} from {dir_binance} ...")
    bnb = load_book_ticker_grid(
        dir_binance, args.binance_symbol,
        grid_ms=grid_ms,
        from_ms=t_01_start,
        to_ms=t_01_end,
    )
    if len(bnb) == 0:
        print("ERROR: no Binance data found in the 01 time range.")
        sys.exit(1)
    print(f"  {len(bnb):,} grid buckets  recv_ms [{bnb['recv_ms'].min()} … {bnb['recv_ms'].max()}]")

    # ---- Overlap check ----
    t_start = max(t_01_start, int(bnb["recv_ms"].min()))
    t_end   = min(t_01_end,   int(bnb["recv_ms"].max()))
    if t_start >= t_end:
        print("ERROR: no overlapping time range.")
        sys.exit(1)
    overlap_h = (t_end - t_start) / 3_600_000
    print(f"Overlap: {t_start} … {t_end}  ({overlap_h:.2f} hours)")

    # ---- Resample 01 to same grid, inner-join ----
    e01_grid = _resample_to_grid(
        e01.filter((pl.col("recv_ms") >= t_start) & (pl.col("recv_ms") <= t_end)),
        grid_ms,
    )
    bnb_grid = bnb.filter(
        (pl.col("recv_ms") >= t_start) & (pl.col("recv_ms") <= t_end)
    ).rename({"recv_ms": "bucket_ms"})

    merged = (
        bnb_grid.join(e01_grid, on="bucket_ms", suffix="_01")
        .sort("bucket_ms")
    )
    print(f"Aligned grid rows: {len(merged):,}")

    if len(merged) < 20:
        print("ERROR: too few aligned rows — check overlap or reduce --grid-ms.")
        sys.exit(1)

    bnb_mid = merged["mid"].to_numpy().astype(float)
    e01_mid = merged["mid_01"].to_numpy().astype(float)

    bnb_ret = _log_returns(bnb_mid)
    e01_ret = _log_returns(e01_mid)

    lags, corrs = _cross_correlate(bnb_ret, e01_ret, max_lag_steps)
    lag_ms = lags * grid_ms

    peak_idx    = int(np.argmax(corrs))
    peak_lag_ms = int(lag_ms[peak_idx])
    peak_corr   = float(corrs[peak_idx])

    print()
    print("=== Cross-venue lead-lag result ===")
    if peak_lag_ms > 0:
        print(f"Binance LEADS 01 by {peak_lag_ms} ms  (corr={peak_corr:.4f})")
    elif peak_lag_ms < 0:
        print(f"01 LEADS Binance by {-peak_lag_ms} ms  (corr={peak_corr:.4f})")
    else:
        print(f"Contemporaneous (lag=0 ms, corr={peak_corr:.4f})")

    print()
    print(f"{'lag_ms':>8}  {'corr':>8}")
    print("-" * 20)
    for l_ms, c in zip(lag_ms.tolist(), corrs.tolist()):
        marker = " <--" if int(l_ms) == peak_lag_ms else ""
        print(f"{int(l_ms):>8}  {c:>8.4f}{marker}")


if __name__ == "__main__":
    main()
