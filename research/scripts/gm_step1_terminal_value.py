#!/usr/bin/env python
"""gm_step1_terminal_value.py — Glosten-Milgrom Step 1: empirical V proxy.

For each public trade, compute mid_{t+h} - mid_t over several horizons h,
grouped by trade direction (taker side). In GM:

    E[V | Buy] - E[V | Sell]  =  A - B  =  mu * (V_high - V_low)

We replace the unobservable terminal value V with mid_{t+h}. If the rynok has
informed flow (mu > 0), the post-trade drift after Buy trades will be strictly
positive on average, and negative after Sell trades. The magnitude of the
difference is a direct, model-implied proxy for the informational component
of the spread.

Side convention on 01 public feed (verified): side 'ask' = aggressor BUY,
side 'bid' = aggressor SELL.

Usage:
  python scripts/gm_step1_terminal_value.py --symbol ETHUSD \
      [--data DIR] [--hours N] [--horizons 0.5,2,10,30,120]
"""
import argparse
import glob
import json
import os
from datetime import datetime, timezone

import duckdb
import numpy as np


def _glob(base, stream, sym):
    return os.path.join(base, stream, sym, "*.parquet")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="ETHUSD")
    ap.add_argument("--data", default="/root/01_xyz/data/mainnet")
    ap.add_argument("--hours", type=float, default=4.0,
                    help="window size in hours, ending at last available ts (ignored if --all or --by-day)")
    ap.add_argument("--horizons", default="0.5,2,10,30,120",
                    help="comma-separated horizons in seconds")
    ap.add_argument("--group-by", choices=["hour", "day", "all"], default="hour",
                    help="group results by hour / day / all (one row)")
    args = ap.parse_args()

    horizons_s = [float(x) for x in args.horizons.split(",")]
    con = duckdb.connect()

    trade_glob = _glob(args.data, "trade", args.symbol)
    snap_glob = _glob(args.data, "snapshot", args.symbol)

    if not glob.glob(trade_glob):
        raise SystemExit(f"no trade parquet found at {trade_glob}")
    if not glob.glob(snap_glob):
        raise SystemExit(f"no snapshot parquet found at {snap_glob}")

    # find end ts (most recent trade)
    t_end = con.execute(
        f"select max(ts) from read_parquet('{trade_glob}')"
    ).fetchone()[0]
    t_min = con.execute(
        f"select min(ts) from read_parquet('{trade_glob}')"
    ).fetchone()[0]

    # Determine window based on --group-by
    if args.group_by == "all":
        t_start = t_min
        print(f"== loading ALL data: {datetime.fromtimestamp(t_start/1000, tz=timezone.utc)} "
              f"-> {datetime.fromtimestamp(t_end/1000, tz=timezone.utc)}")
    else:
        t_start = t_end - int(args.hours * 3600 * 1000)
        print(f"== window: {datetime.fromtimestamp(t_start/1000, tz=timezone.utc)} "
              f"-> {datetime.fromtimestamp(t_end/1000, tz=timezone.utc)} "
              f"({args.hours}h) [--group-by {args.group_by}]")

    # load all trades in range
    trades = con.execute(f"""
        select ts, side, price, size
        from read_parquet('{trade_glob}')
        where ts between {t_start} and {t_end}
        order by ts
    """).fetchnumpy()

    n_tr = len(trades["ts"])
    if n_tr == 0:
        raise SystemExit("no trades in window")
    print(f"== trades in window: {n_tr}")

    # load snapshots, build mid timeline
    snaps = con.execute(f"""
        select ts, bids, asks
        from read_parquet('{snap_glob}')
        where ts between {t_start - 5*60*1000} and {t_end + 5*60*1000}
        order by ts
    """).fetchnumpy()

    n_sn = len(snaps["ts"])
    if n_sn == 0:
        raise SystemExit("no snapshots in window")

    bb = np.full(n_sn, np.nan)
    ba = np.full(n_sn, np.nan)
    for i, (bj, aj) in enumerate(zip(snaps["bids"], snaps["asks"])):
        try:
            b = json.loads(bj)
            a = json.loads(aj)
            if b:
                bb[i] = b[0][0]
            if a:
                ba[i] = a[0][0]
        except (TypeError, json.JSONDecodeError):
            pass
    mid = (bb + ba) / 2
    valid = np.isfinite(mid)
    snap_ts = snaps["ts"][valid]
    mid = mid[valid]
    print(f"== snapshots with valid mid: {len(mid)} (sparse, ~1 per 60s)")

    # Process: group by hour, day, or all
    def process_batch(batch_ts, batch_side, batch_name):
        """Compute drifts for a batch of trades."""
        if len(batch_ts) == 0:
            return None

        tr_ts = batch_ts.astype(np.int64)
        is_buy = batch_side == "ask"
        is_sell = batch_side == "bid"

        if is_buy.sum() < 5 or is_sell.sum() < 5:
            return None

        def mid_at(ts_arr):
            idx = np.searchsorted(snap_ts, ts_arr, side="right") - 1
            out = np.full(len(ts_arr), np.nan)
            ok = idx >= 0
            out[ok] = mid[idx[ok]]
            return out

        mid_t = mid_at(tr_ts)
        rows = []

        for h in horizons_s:
            h_ms = int(h * 1000)
            mid_th = mid_at(tr_ts + h_ms)
            drift_abs = mid_th - mid_t
            drift_bps = drift_abs / mid_t * 1e4

            buy_d = drift_bps[is_buy & np.isfinite(drift_bps)]
            sell_d = drift_bps[is_sell & np.isfinite(drift_bps)]

            if len(buy_d) < 5 or len(sell_d) < 5:
                continue

            mb, ms = buy_d.mean(), sell_d.mean()
            vb, vs = buy_d.var(ddof=1), sell_d.var(ddof=1)
            nb, ns = len(buy_d), len(sell_d)
            se = float(np.sqrt(vb/nb + vs/ns))
            diff = mb - ms
            t_stat = diff / se if se > 0 else 0.0

            rows.append((h, nb, ns, mb, ms, diff, t_stat))

        return (batch_name, rows)

    # Group trades
    tr_ts = trades["ts"].astype(np.int64)
    tr_side = trades["side"]
    batches = []

    if args.group_by == "all":
        batches.append(("all", tr_ts, tr_side))
    elif args.group_by == "day":
        # Group by calendar day (UTC)
        for ts in tr_ts:
            day_start = (ts // (24*3600*1000)) * (24*3600*1000)
            break

        day = day_start
        while day <= t_end:
            day_end = day + 24*3600*1000
            mask = (tr_ts >= day) & (tr_ts < day_end)
            if mask.sum() > 0:
                day_label = datetime.fromtimestamp(day/1000, tz=timezone.utc).strftime("%Y-%m-%d")
                batches.append((day_label, tr_ts[mask], tr_side[mask]))
            day = day_end
    else:  # hour
        day = (tr_ts[0] // (3600*1000)) * (3600*1000)
        while day <= t_end:
            hour_end = day + 3600*1000
            mask = (tr_ts >= day) & (tr_ts < hour_end)
            if mask.sum() > 0:
                hour_label = datetime.fromtimestamp(day/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:00")
                batches.append((hour_label, tr_ts[mask], tr_side[mask]))
            day = hour_end

    # Print results
    print("\n" + "="*88)
    print(f"{'batch':>20s} {'horizon':>8s} {'N_buy':>8s} {'N_sell':>8s} "
          f"{'drift_buy':>12s} {'drift_sell':>12s} "
          f"{'A-B(bps)':>10s} {'t-stat':>8s}")
    print("="*88)
    print(f"{'':>20s} {'units:':>8s} {'#':>8s} {'#':>8s} "
          f"{'bps':>12s} {'bps':>12s} {'bps':>10s} {'':>8s}")
    print("-"*88)

    for batch_name, batch_ts, batch_side in batches:
        result = process_batch(batch_ts, batch_side, batch_name)
        if result is None:
            print(f"{batch_name:>20s} (too few obs)")
            continue

        _, rows = result
        for i, (h, nb, ns, mb, ms, diff, t_stat) in enumerate(rows):
            label = batch_name if i == 0 else ""
            print(f"{label:>20s} {h:>8.1f} {nb:>8d} {ns:>8d} "
                  f"{mb:>+12.3f} {ms:>+12.3f} "
                  f"{diff:>+10.3f} {t_stat:>+8.2f}")
        print("-"*88)

    print("\nInterpretation (GM):")
    print("  drift_buy  > 0  AND  drift_sell < 0  => informed flow exists (mu > 0)")
    print("  drift_buy ~= drift_sell             => no asymmetric info (Roll world)")
    print("  A-B(bps) is the empirical proxy for mu * (V_high - V_low) in bps.")


if __name__ == "__main__":
    main()
