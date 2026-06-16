"""
Label generation — forward-looking labels computed from the mid-price series.

Labels are only used in training; the TS inference side never sees them.
All labels use future data (by definition), so they're computed in a separate
pass AFTER features, and the train/test split enforces PIT correctness.
"""

import polars as pl


def add_forward_labels(df: pl.DataFrame, mid_col: str = "mid") -> pl.DataFrame:
    """
    Add forward return labels to a feature DataFrame.

    Expects columns: ts (ms), mid (float). Adds:
      fwd_return_1s   — mid return over next 1s
      fwd_return_5s   — mid return over next 5s
      fwd_return_30s  — mid return over next 30s
      fwd_return_sign_5s — 1 if 5s return > 0, else 0

    Uses asof-join against the mid series shifted forward by the horizon.
    Rows where the horizon extends past the end of data get null labels
    (dropped during training).
    """
    ts_col = "ts"
    result = df.clone()

    # Build a lookup: for each horizon, find the mid at ts + horizon
    mids = df.select([ts_col, mid_col]).sort(ts_col)

    for horizon_ms, label_name in [
        (1_000, "fwd_return_1s"),
        (5_000, "fwd_return_5s"),
        (30_000, "fwd_return_30s"),
    ]:
        # Shift timestamps back by horizon so asof-join finds the future mid
        future = mids.rename({ts_col: "ts_future", mid_col: "mid_future"})
        future = future.with_columns(
            (pl.col("ts_future") - horizon_ms).alias("ts_join")
        )

        joined = result.join_asof(
            future.select(["ts_join", "mid_future"]),
            left_on=ts_col,
            right_on="ts_join",
            strategy="nearest",
        )

        result = joined.with_columns(
            pl.when(pl.col("mid_future").is_not_null() & (pl.col(mid_col) > 0))
            .then((pl.col("mid_future") - pl.col(mid_col)) / pl.col(mid_col))
            .otherwise(None)
            .alias(label_name)
        ).drop("mid_future")

    # Classification label: sign of 5s return
    result = result.with_columns(
        pl.when(pl.col("fwd_return_5s").is_not_null())
        .then(pl.when(pl.col("fwd_return_5s") > 0).then(1).otherwise(0))
        .otherwise(None)
        .alias("fwd_return_sign_5s")
    )

    return result
