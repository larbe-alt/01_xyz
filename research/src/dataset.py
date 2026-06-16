"""
Dataset builder — the main entry point for constructing training datasets.

Orchestrates: load events → replay book → compute features at sample rate →
add forward labels → output polars DataFrame.

PIT guarantee: features at time T use only events with ts <= T.
Labels look forward (by design) and are separated by the purge gap in train/test.
"""

import polars as pl

from .data import load_events, replay_book, TradeWindow, MidHistory
from .features import compute_all, FEATURE_NAMES
from .labels import add_forward_labels


def build_dataset(
    data_dir: str,
    env: str,
    symbol: str,
    sample_ms: int = 1_000,
    from_ts: int | None = None,
    to_ts: int | None = None,
) -> pl.DataFrame:
    """
    Build a feature+label dataset from native01 parquet data.

    Args:
        data_dir: path to data/ directory
        env: "mainnet" or "devnet"
        symbol: market symbol (e.g. "ETHUSD")
        sample_ms: compute features every N ms (default 1s)
        from_ts: optional start timestamp filter (ms)
        to_ts: optional end timestamp filter (ms)

    Returns:
        polars DataFrame with columns: ts, mid, <all features>, <all labels>
    """
    events = load_events(data_dir, env, symbol)
    if from_ts is not None:
        events = [e for e in events if e.ts >= from_ts]
    if to_ts is not None:
        events = [e for e in events if e.ts <= to_ts]
    if not events:
        raise ValueError(f"No events for {symbol} in {data_dir}/{env}")

    tw = TradeWindow(max_window_ms=300_000)
    mh = MidHistory(max_window_ms=300_000)

    rows: list[dict] = []
    next_sample_ts = 0

    for book, ev in replay_book(events):
        # Update trade window + mid history
        if ev.kind == "trade" and ev.trade is not None:
            tw.add(ev.trade)
            mid = book.mid()
            if mid is not None:
                mh.add(ev.ts, mid)

        if ev.kind in ("snapshot", "delta"):
            mid = book.mid()
            if mid is not None:
                mh.add(ev.ts, mid)

        # Sample at configured rate
        if ev.ts < next_sample_ts:
            continue

        mid = book.mid()
        if mid is None:
            continue

        tw.prune(ev.ts)
        mh.prune(ev.ts)

        feats = compute_all(book, tw, mh, ev.ts)
        row = {"ts": ev.ts, "mid": mid, **feats}
        rows.append(row)
        next_sample_ts = ev.ts + sample_ms

    if not rows:
        raise ValueError(f"No valid samples produced for {symbol}")

    df = pl.DataFrame(rows)
    df = add_forward_labels(df, mid_col="mid")
    return df
