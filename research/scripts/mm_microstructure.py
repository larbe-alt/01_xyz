#!/usr/bin/env python3
"""
mm_microstructure.py — MM-tuning stats from recorder parquets (snapshot/delta/trade).

Emits JSON with three core stats:
  1. taker_size — percentiles of taker order size (per side)
  2. delta_block_bps — distribution of |mid(t+Δ) - mid(t)|/mid for Δ ∈ {400ms,1s,5s}
  3. lambda_fit — exponential fit λ(δ) = A·exp(-k·δ) where δ = |fill_price - mid| (bps)

Designed to run on the VPS where the recorder writes:
  /root/perpl/.venv/bin/python mm_microstructure.py \\
      --data-dir /root/01_xyz/data/mainnet --symbol ETHUSD --hours 6

Pure Python + pyarrow only (no numpy/pandas/scipy). Suitable for a 1GB VPS.
"""
import argparse
import glob
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

import pyarrow.parquet as pq

FNAME_RE = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})\.parquet$")


def fname_to_ms(path):
    m = FNAME_RE.search(path)
    if not m:
        return None
    d, hh, mm = m.group(1), m.group(2), m.group(3)
    dt = datetime.strptime(f"{d}T{hh}:{mm}", "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def files_in_window(base, sym, stream, start_ms, end_ms, pad_before_min=0):
    """Filter files whose 5-min bucket may overlap [start-pad, end]."""
    paths = sorted(glob.glob(os.path.join(base, stream, sym, "*.parquet")))
    pad = pad_before_min * 60 * 1000
    bucket_ms = 5 * 60 * 1000
    out = []
    for p in paths:
        ts = fname_to_ms(p)
        if ts is None:
            continue
        if ts + bucket_ms < start_ms - pad:
            continue
        if ts > end_ms:
            continue
        out.append(p)
    return out


def percentile(arr, q):
    if not arr:
        return None
    s = sorted(arr)
    k = q * (len(s) - 1)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)


def qdict(arr):
    return {
        "n": len(arr),
        **{f"p{int(q * 100)}": percentile(arr, q) for q in (0.5, 0.75, 0.9, 0.95, 0.99)},
    }


def paired_indices(ts, win_ms, gap_mult=3):
    """Yield (i, j) where ts[j] is the first sample at least win_ms after ts[i].
    Skips pairs where the gap exceeds gap_mult * win_ms (sparse data filter).
    Single monotonic forward pass — j never moves backward across i."""
    n = len(ts)
    j = 0
    for i in range(n):
        if j < i:
            j = i
        target = ts[i] + win_ms
        while j < n and ts[j] < target:
            j += 1
        if j >= n:
            return
        if ts[j] - ts[i] > gap_mult * win_ms:
            continue
        yield i, j


def vol_stats(returns, h_ms):
    n = len(returns)
    if n < 10:
        return {"sigma_bps": None, "sigma_bps_per_sqrt_sec": None, "n_samples": n}
    mean = sum(returns) / n
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)
    sigma_bps = math.sqrt(var) * 1e4
    return {
        "sigma_bps": sigma_bps,
        "sigma_bps_per_sqrt_sec": sigma_bps / math.sqrt(h_ms / 1000),
        "n_samples": n,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--symbol", default="ETHUSD")
    ap.add_argument("--hours", type=float, default=6.0)
    ap.add_argument("--end-ms", type=int, default=None, help="window end (default: latest trade ts)")
    args = ap.parse_args()

    sym = args.symbol
    base = args.data_dir

    # ── window ────────────────────────────────────────────────────────────────
    trade_paths_all = sorted(glob.glob(os.path.join(base, "trade", sym, "*.parquet")))
    if not trade_paths_all:
        sys.exit(f"No trade parquets at {base}/trade/{sym}")
    if args.end_ms is None:
        last = pq.read_table(trade_paths_all[-1], columns=["ts"])["ts"].to_pylist()
        end_ms = int(max(last))
    else:
        end_ms = args.end_ms
    start_ms = end_ms - int(args.hours * 3600 * 1000)
    window_sec = (end_ms - start_ms) / 1000.0

    # ── 1. trades + taker size ────────────────────────────────────────────────
    trades = []  # (ts, side, price, size)
    for f in files_in_window(base, sym, "trade", start_ms, end_ms):
        tbl = pq.read_table(f, columns=["ts", "side", "price", "size"])
        ts_l = tbl["ts"].to_pylist()
        sd_l = tbl["side"].to_pylist()
        px_l = tbl["price"].to_pylist()
        sz_l = tbl["size"].to_pylist()
        for i in range(len(ts_l)):
            t = ts_l[i]
            if start_ms <= t <= end_ms:
                trades.append((t, sd_l[i], px_l[i], sz_l[i]))
    trades.sort(key=lambda x: x[0])

    sizes_bid = [t[3] for t in trades if t[1] == "bid"]
    sizes_ask = [t[3] for t in trades if t[1] == "ask"]
    taker_size = {
        "all": qdict([t[3] for t in trades]),
        "bid_taker": qdict(sizes_bid),
        "ask_taker": qdict(sizes_ask),
    }

    # ── 2. snapshot init + delta replay → BBO timeseries ──────────────────────
    snap_files = files_in_window(base, sym, "snapshot", start_ms, end_ms, pad_before_min=120)
    delta_files = files_in_window(base, sym, "delta", start_ms, end_ms, pad_before_min=120)

    init = None  # (ts, bids_str, asks_str)
    fallback = None
    for f in snap_files:
        tbl = pq.read_table(f, columns=["ts", "bids", "asks"])
        ts_l = tbl["ts"].to_pylist()
        b_l = tbl["bids"].to_pylist()
        a_l = tbl["asks"].to_pylist()
        for i in range(len(ts_l)):
            if ts_l[i] <= start_ms:
                init = (ts_l[i], b_l[i], a_l[i])
            else:
                if fallback is None:
                    fallback = (ts_l[i], b_l[i], a_l[i])
    if init is None:
        if fallback is None:
            sys.exit("No snapshot found anywhere near window")
        init = fallback
        print(f"WARN: no snapshot before window start; using earliest at {init[0]}", file=sys.stderr)

    bids = {}
    asks = {}
    for p, sz in json.loads(init[1]):
        if sz > 0:
            bids[p] = sz
    for p, sz in json.loads(init[2]):
        if sz > 0:
            asks[p] = sz
    book_ts = init[0]

    bbo_ts, bbo_mid = [], []
    if bids and asks:
        bb, aa = max(bids), min(asks)
        if bb < aa:
            bbo_ts.append(book_ts)
            bbo_mid.append((bb + aa) / 2)

    # Replay deltas (only those with ts >= book_ts, ts <= end_ms)
    last_mid = bbo_mid[-1] if bbo_mid else None
    for f in delta_files:
        tbl = pq.read_table(f, columns=["ts", "bids", "asks"])
        ts_l = tbl["ts"].to_pylist()
        b_l = tbl["bids"].to_pylist()
        a_l = tbl["asks"].to_pylist()
        for i in range(len(ts_l)):
            t = ts_l[i]
            if t < book_ts or t > end_ms:
                continue
            for p, sz in json.loads(b_l[i]):
                if sz == 0:
                    bids.pop(p, None)
                else:
                    bids[p] = sz
            for p, sz in json.loads(a_l[i]):
                if sz == 0:
                    asks.pop(p, None)
                else:
                    asks[p] = sz
            if bids and asks:
                bb, aa = max(bids), min(asks)
                if bb < aa:
                    m = (bb + aa) / 2
                    # dedupe consecutive identical mids
                    if last_mid is None or m != last_mid:
                        bbo_ts.append(t)
                        bbo_mid.append(m)
                        last_mid = m

    n_bbo = len(bbo_ts)
    if n_bbo < 2:
        sys.exit(f"Not enough BBO points to compute stats (got {n_bbo})")

    # ── 3. Δblock at 400ms / 1s / 5s ──────────────────────────────────────────
    delta_block = {}
    for label, win_ms in (("400ms", 400), ("1s", 1000), ("5s", 5000)):
        moves = [abs(bbo_mid[j] - bbo_mid[i]) / bbo_mid[i] * 1e4
                 for i, j in paired_indices(bbo_ts, win_ms)]
        delta_block[label] = qdict(moves)

    # ── 4. mid log-return σ at multiple horizons ──────────────────────────────
    mid_volatility = {}
    for label, h_ms in (("1s", 1000), ("5s", 5000), ("30s", 30000), ("60s", 60000)):
        rets = [math.log(bbo_mid[j] / bbo_mid[i]) for i, j in paired_indices(bbo_ts, h_ms)]
        mid_volatility[label] = vol_stats(rets, h_ms)

    # ── 5. λ(δ): bin trades by |fill - mid_at_fill| in bps ────────────────────
    bbo_min, bbo_max = bbo_ts[0], bbo_ts[-1]
    valid_trades = [t for t in trades if bbo_min <= t[0] <= bbo_max]

    bins = defaultdict(int)  # bps_bucket -> count
    j = 0
    for t, side, px, sz in valid_trades:
        while j + 1 < n_bbo and bbo_ts[j + 1] <= t:
            j += 1
        m = bbo_mid[j]
        d_bps = abs(px - m) / m * 1e4
        if d_bps < 40:
            bins[int(d_bps)] += 1

    # bbo-observed span sets the effective intensity window
    span_sec = (bbo_max - bbo_min) / 1000.0

    # log-linear fit on (δ, ln(rate)) for δ in [0, 20] bps with non-zero counts
    pts = []
    for b in sorted(bins.keys()):
        if b > 20:
            continue
        rate = bins[b] / span_sec
        if rate > 0:
            pts.append((b + 0.5, math.log(rate)))

    A = k = halflife = None
    if len(pts) >= 3:
        n = len(pts)
        mx = sum(p[0] for p in pts) / n
        my = sum(p[1] for p in pts) / n
        num = sum((p[0] - mx) * (p[1] - my) for p in pts)
        den = sum((p[0] - mx) ** 2 for p in pts)
        if den > 0:
            slope = num / den
            intercept = my - slope * mx
            A = math.exp(intercept)
            k = -slope
            if k > 0:
                halflife = math.log(2) / k

    lambda_fit = {
        "A_per_sec": A,
        "k_per_bps": k,
        "halflife_bps": halflife,
        "fit_points": len(pts),
        "n_fills_binned": sum(bins.values()),
        "span_sec": span_sec,
        "histogram_bps": {str(b): bins[b] for b in sorted(bins.keys())},
    }

    # ── derived recommendations ───────────────────────────────────────────────
    rec = {}
    if "400ms" in delta_block and delta_block["400ms"].get("p90") is not None:
        rec["min_half_spread_bps_from_dblock_p90"] = delta_block["400ms"]["p90"]
    if k and k > 0:
        # Avellaneda–Stoikov optimal half-spread at γ=0 is 1/k (in same units as δ).
        rec["zero_inv_half_spread_bps_from_lambda"] = 1.0 / k

    out = {
        "window": {
            "symbol": sym,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "hours": args.hours,
            "window_sec": window_sec,
            "bbo_points": n_bbo,
            "trades": len(trades),
        },
        "taker_size": taker_size,
        "delta_block_bps": delta_block,
        "lambda_fit": lambda_fit,
        "mid_volatility": mid_volatility,
        "recommendations": rec,
    }
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
