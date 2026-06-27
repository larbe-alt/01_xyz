"""
Cross-venue lead-lag probe: does Binance price discovery lead 01 Exchange?

Method:
  1. Build a mid-price series for 01 from snapshot+delta replay (ts receive clock).
  2. Build a grid-resampled mid series for Binance from book_ticker (recv_ms clock),
     downsampled IN SQL so only ~MBs leave duckdb (VPS-safe).
  3. Both recorders run on the same VPS → clocks are co-located → no NTP skew.
  4. Reindex BOTH onto a dense, uniform grid over the overlap (forward-fill held
     mids) so "lag = k steps" == k * grid_ms; compute log-returns; per-lag Pearson
     cross-correlate. (A sparse inner-join would let a return straddle a gap and
     break the lag↔time mapping.)
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
    """Replay 01 parquet snapshot+delta → (ts ms, mid) series."""
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

def _log_returns(series: np.ndarray) -> tuple[np.ndarray, float]:
    """Elementwise log-returns on a uniform grid.

    A step is valid only if BOTH endpoints are positive; invalid steps are set to
    0 *individually* (not the whole series) and reported as `invalid_frac` so the
    caller can fail loud — a single bad mid must not silently zero everything.
    """
    series = np.asarray(series, dtype=float)
    r = np.zeros_like(series)
    if len(series) < 2:
        return r, 0.0
    prev, cur = series[:-1], series[1:]
    valid = (prev > 0) & (cur > 0)
    r[1:][valid] = np.log(cur[valid] / prev[valid])
    invalid_frac = float(1.0 - valid.mean())
    return r, invalid_frac


def _cross_correlate(x: np.ndarray, y: np.ndarray, max_lag: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Per-lag Pearson cross-correlation at lags -max_lag … +max_lag.
    lag > 0 → x leads y (x at t correlates with y at t+lag).

    Each lag's correlation is computed on its own overlapping window (mean removed
    per window, normalised by both windows' std) so values are true correlations
    bounded in [-1, 1] and comparable across lags. NaN where the window is too short.
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    max_lag = max(0, min(max_lag, n - 1))
    lags = np.arange(-max_lag, max_lag + 1)
    corrs = np.full(len(lags), np.nan)
    for i, lag in enumerate(lags):
        if lag >= 0:
            a, b = x[:n - lag], y[lag:]
        else:
            a, b = x[-lag:], y[:n + lag]
        if len(a) < 3:
            continue
        a = a - a.mean()
        b = b - b.mean()
        denom = np.sqrt(float((a * a).sum()) * float((b * b).sum()))
        if denom > 0:
            corrs[i] = float((a * b).sum() / denom)
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
    parser.add_argument("--binance-grid-parquet", default=None,
                        help="Pre-gridded Binance parquet (cols recv_ms,bid,ask,mid). "
                             "If set, skip the SQL reduction — use when Binance was "
                             "reduced on the VPS and analysis runs off-box. MUST match --grid-ms.")
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

    # ---- Binance mid series (grid-resampled in SQL, or pre-reduced parquet) ----
    if args.binance_grid_parquet:
        print(f"Loading pre-gridded Binance parquet {args.binance_grid_parquet} "
              f"(assumed {grid_ms}ms grid) ...")
        bnb = (
            pl.read_parquet(args.binance_grid_parquet)
            .filter((pl.col("recv_ms") >= t_01_start) & (pl.col("recv_ms") <= t_01_end))
            .sort("recv_ms")
        )
    else:
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

    # ---- Build a DENSE, uniform grid over the overlap ----
    # Critical: cross-correlation maps "lag = k steps" to "k * grid_ms" only if the
    # rows are uniformly spaced. Inner-joining sparse buckets (the old approach)
    # dropped quiet buckets, so adjacent rows could be seconds apart and a single
    # log-return could straddle a multi-second gap. We instead reindex both venues
    # onto a contiguous grid and forward-fill the last known mid (a held price → a
    # zero return, which is correct: no trade, no move).
    e01_grid = _resample_to_grid(
        e01.filter((pl.col("recv_ms") >= t_start) & (pl.col("recv_ms") <= t_end)),
        grid_ms,
    )
    bnb_grid = (
        bnb.filter((pl.col("recv_ms") >= t_start) & (pl.col("recv_ms") <= t_end))
        .select(["recv_ms", "mid"])
        .rename({"recv_ms": "bucket_ms"})
        .sort("bucket_ms")
    )

    b_start = (t_start // grid_ms) * grid_ms
    b_end   = (t_end   // grid_ms) * grid_ms
    n_dense = (b_end - b_start) // grid_ms + 1
    if n_dense > 5_000_000:
        print(f"ERROR: dense grid would be {n_dense:,} rows — narrow the window or "
              f"raise --grid-ms (VPS RAM guard).")
        sys.exit(1)

    dense = pl.DataFrame(
        {"bucket_ms": np.arange(b_start, b_end + grid_ms, grid_ms, dtype=np.int64)}
    )

    def _reindex(grid_df: pl.DataFrame) -> pl.DataFrame:
        return (
            dense.join(grid_df, on="bucket_ms", how="left")
            .sort("bucket_ms")
            .with_columns(pl.col("mid").forward_fill())
        )

    e01_d = _reindex(e01_grid).rename({"mid": "mid_01"})
    bnb_d = _reindex(bnb_grid)

    # Inner-join on the shared dense axis, then drop only the leading buckets that
    # precede the first quote on either venue → the remainder stays contiguous.
    merged = (
        bnb_d.join(e01_d, on="bucket_ms")
        .drop_nulls(["mid", "mid_01"])
        .sort("bucket_ms")
    )
    print(f"Aligned dense grid rows: {len(merged):,}  (uniform {grid_ms}ms spacing)")

    if len(merged) < 20:
        print("ERROR: too few aligned rows — check overlap or reduce --grid-ms.")
        sys.exit(1)

    bnb_mid = merged["mid"].to_numpy().astype(float)
    e01_mid = merged["mid_01"].to_numpy().astype(float)

    bnb_ret, bnb_bad = _log_returns(bnb_mid)
    e01_ret, e01_bad = _log_returns(e01_mid)
    if bnb_bad > 0.01 or e01_bad > 0.01:
        print(f"WARNING: non-positive mids — Binance {bnb_bad:.1%}, 01 {e01_bad:.1%} "
              f"of steps zeroed; lead-lag may be distorted.")

    lags, corrs = _cross_correlate(bnb_ret, e01_ret, max_lag_steps)
    lag_ms = lags * grid_ms

    if np.all(np.isnan(corrs)):
        print("ERROR: cross-correlation undefined (series too short or flat).")
        sys.exit(1)
    peak_idx    = int(np.nanargmax(corrs))
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
