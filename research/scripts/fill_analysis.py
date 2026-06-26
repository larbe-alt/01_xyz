#!/usr/bin/env python3
"""
fill_analysis.py — Per-fill adverse selection analysis for the MM backtest.

For each fill in trades.json, looks up what the mid price was at +5s / +30s / +60s
using the recorded trade parquets, then computes:
  - adverse_move_bps: how far mid moved against us (positive = bad)
  - was_adverse: bool (mid moved against us by > 0.5 bps)

Usage:
  python fill_analysis.py \
    --trades /root/01_xyz/results/bt_xxx/trades.json \
    --data-dir /root/01_xyz/data/mainnet \
    --symbol ETHUSD
"""
import argparse
import glob
import json
import math
import os
import re
import sys

import pyarrow.parquet as pq

FNAME_RE = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})\.parquet$")
BUCKET_MS = 5 * 60 * 1000


def fname_to_ms(path):
    m = FNAME_RE.search(path)
    if not m:
        return None
    from datetime import datetime, timezone
    d, hh, mm = m.group(1), m.group(2), m.group(3)
    dt = datetime.strptime(f"{d}T{hh}:{mm}", "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def load_price_series(data_dir, symbol, start_ms, end_ms):
    """Load (ts, price) from trade parquets, covering start_ms - 5min to end_ms + 65s."""
    pad_before = 5 * 60 * 1000
    pad_after = 65 * 1000
    paths = sorted(glob.glob(os.path.join(data_dir, "trade", symbol, "*.parquet")))
    pts = []
    for p in paths:
        t = fname_to_ms(p)
        if t is None:
            continue
        if t + BUCKET_MS < start_ms - pad_before:
            continue
        if t > end_ms + pad_after:
            continue
        tbl = pq.read_table(p, columns=["ts", "price"])
        for ts, px in zip(tbl["ts"].to_pylist(), tbl["price"].to_pylist()):
            ts = int(ts)
            if start_ms - pad_before <= ts <= end_ms + pad_after:
                pts.append((ts, px))
    pts.sort(key=lambda x: x[0])
    return pts


def mid_after(price_series, fill_ts, delay_ms):
    """Return the first trade price at fill_ts + delay_ms (±20% window). None if no data."""
    target = fill_ts + delay_ms
    lo, hi = target - delay_ms // 5, target + delay_ms // 5
    for ts, px in price_series:
        if ts >= lo:
            if ts <= hi:
                return px
            break
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trades", required=True, help="Path to trades.json from backtest")
    ap.add_argument("--data-dir", required=True, help="Base data dir (e.g. /root/01_xyz/data/mainnet)")
    ap.add_argument("--symbol", default="ETHUSD")
    args = ap.parse_args()

    with open(args.trades) as f:
        trades = json.load(f)

    if not trades:
        sys.exit("No trades in file")

    sym_trades = [t for t in trades if t["symbol"] == args.symbol]
    if not sym_trades:
        sys.exit(f"No trades for symbol {args.symbol}")

    start_ms = min(t["ts"] for t in sym_trades)
    end_ms = max(t["ts"] for t in sym_trades)

    print(f"Loading price series for {args.symbol} ({len(sym_trades)} fills)...", file=sys.stderr)
    price_series = load_price_series(args.data_dir, args.symbol, start_ms, end_ms)
    print(f"Loaded {len(price_series)} trade prints", file=sys.stderr)

    rows = []
    for t in sym_trades:
        ts = t["ts"]
        side = t["side"]           # "bid" (we bought) or "ask" (we sold)
        fill_px = t["price"]
        mid = t["midAtFill"]
        slip_bps = (t["slippage"] / mid * 1e4) if mid else 0  # negative = we paid below mid (maker bid)
        realized = t["realizedPnl"]
        pos_after = t["positionAfter"]

        m5  = mid_after(price_series, ts, 5_000)
        m30 = mid_after(price_series, ts, 30_000)
        m60 = mid_after(price_series, ts, 60_000)

        # adverse move: positive = price moved against us
        # if we bought (bid fill): adverse if price went DOWN (mid_after < mid)
        # if we sold (ask fill):   adverse if price went UP   (mid_after > mid)
        def adv(m_after):
            if m_after is None or mid == 0:
                return None
            move = (m_after - mid) / mid * 1e4  # bps
            return -move if side == "bid" else move

        rows.append({
            "ts": ts,
            "side": side,
            "fill_px": round(fill_px, 4),
            "mid": round(mid, 4),
            "slip_bps": round(slip_bps, 2),
            "realized_pnl": round(realized, 4),
            "pos_after": round(pos_after, 4),
            "adv_5s":  round(adv(m5),  2) if adv(m5)  is not None else None,
            "adv_30s": round(adv(m30), 2) if adv(m30) is not None else None,
            "adv_60s": round(adv(m60), 2) if adv(m60) is not None else None,
        })

    # ── Summary ──────────────────────────────────────────────────────────────
    def stats(vals):
        vs = [v for v in vals if v is not None]
        if not vs:
            return {}
        vs.sort()
        n = len(vs)
        mean = sum(vs) / n
        return {
            "n": n,
            "mean": round(mean, 2),
            "p25": round(vs[n // 4], 2),
            "p50": round(vs[n // 2], 2),
            "p75": round(vs[3 * n // 4], 2),
            "pct_adverse": round(sum(1 for v in vs if v > 0.5) / n * 100, 1),
        }

    adv5  = [r["adv_5s"]  for r in rows]
    adv30 = [r["adv_30s"] for r in rows]
    adv60 = [r["adv_60s"] for r in rows]

    # slip buckets
    pos_slip = [r for r in rows if r["slip_bps"] <= -2]   # fill far from mid (deep inside)
    neg_slip = [r for r in rows if r["slip_bps"] > -2]    # fill near / at mid

    print(json.dumps({
        "symbol": args.symbol,
        "total_fills": len(rows),
        "fills": rows,
        "adverse_selection": {
            "at_5s":  stats(adv5),
            "at_30s": stats(adv30),
            "at_60s": stats(adv60),
        },
        "by_slip_bucket": {
            "near_mid (slip > -2bps)": {
                "n": len(neg_slip),
                "adv_5s_mean": round(sum(r["adv_5s"] or 0 for r in neg_slip) / max(len(neg_slip), 1), 2),
            },
            "deep_fill (slip <= -2bps)": {
                "n": len(pos_slip),
                "adv_5s_mean": round(sum(r["adv_5s"] or 0 for r in pos_slip) / max(len(pos_slip), 1), 2),
            },
        },
        "by_side": {
            side: stats([r["adv_5s"] for r in rows if r["side"] == side])
            for side in ("bid", "ask")
        },
    }, indent=2))


if __name__ == "__main__":
    main()
