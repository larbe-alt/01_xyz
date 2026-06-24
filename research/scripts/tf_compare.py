"""
Build OHLCV bars from raw ticks for ETHUSD across multiple timeframes,
then compare stats: price, volatility, log returns, max drawdown,
multi-lag autocorr, strong-bar win rate, rolling volatility.
"""

import glob
import os
import numpy as np
import pandas as pd

SYMBOL     = "ETHUSD"
TRADE_DIR  = f"data/mainnet/trade/{SYMBOL}"
TIMEFRAMES = ["5s", "10s", "15s", "30s", "1min"]
OUT_DIR    = "research/output"

# ── 1. Load all ticks ─────────────────────────────────────────────────────────

files = sorted(glob.glob(f"{TRADE_DIR}/*.parquet"))
if not files:
    raise FileNotFoundError(f"No trade parquets in {TRADE_DIR}")

raw = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
raw["ts"] = pd.to_datetime(raw["ts"], unit="ms", utc=True)
ticks = raw.drop_duplicates("ts").sort_values("ts").reset_index(drop=True)

print(f"Ticks loaded : {len(ticks):,}")
print(f"Range        : {ticks['ts'].iloc[0]}  →  {ticks['ts'].iloc[-1]}")
hours = (ticks['ts'].iloc[-1] - ticks['ts'].iloc[0]).total_seconds() / 3600
print(f"Duration     : {hours:.1f} hours\n")


# ── 2. Build OHLCV for each timeframe ─────────────────────────────────────────

def build_ohlcv(ticks: pd.DataFrame, freq: str) -> pd.DataFrame:
    t = ticks.set_index("ts")
    ohlcv = t["price"].resample(freq).ohlc()
    ohlcv["volume"] = t["size"].resample(freq).sum()
    ohlcv = ohlcv.dropna(subset=["open"])
    return ohlcv


bars = {tf: build_ohlcv(ticks, tf) for tf in TIMEFRAMES}


# ── 3. Stats per timeframe ────────────────────────────────────────────────────

def max_drawdown(close: pd.Series):
    roll_max   = close.cummax()
    dd         = (close - roll_max) / roll_max
    trough_idx = dd.idxmin()
    peak_idx   = roll_max[:trough_idx].idxmax()
    return dd.min(), close[peak_idx], close[trough_idx], peak_idx, trough_idx


def compute_stats(df: pd.DataFrame, tf: str) -> dict:
    close   = df["close"].dropna()
    log_ret = np.log(close / close.shift(1)).dropna()

    tf_map = {"5s": 6_307_200, "10s": 3_153_600, "15s": 2_102_400,
              "30s": 1_051_200, "1min": 525_600}
    ann_f  = np.sqrt(tf_map[tf])

    mdd, pk, tr, pk_idx, tr_idx = max_drawdown(close)

    return {
        "tf"          : tf,
        "bars"        : len(df),
        "price_min"   : close.min(),
        "price_max"   : close.max(),
        "price_mean"  : close.mean(),
        "price_std"   : close.std(),
        "vol_per_bar" : log_ret.std() * 100,
        "ann_vol"     : log_ret.std() * ann_f * 100,
        "logret_min"  : log_ret.min() * 100,
        "logret_max"  : log_ret.max() * 100,
        "logret_mean" : log_ret.mean() * 100,
        "logret_cum"  : log_ret.sum() * 100,
        "max_dd"      : mdd * 100,
        "peak_px"     : pk,
        "trough_px"   : tr,
        "peak_ts"     : pk_idx,
        "trough_ts"   : tr_idx,
        "volume_total": df["volume"].sum(),
        "empty_bars"  : (df["volume"] == 0).sum(),
    }


stats = [compute_stats(bars[tf], tf) for tf in TIMEFRAMES]


# ── 4. Print base comparison ───────────────────────────────────────────────────

SEP  = "═" * 66
sep2 = "─" * 66
W    = 10

def hdr(label: str) -> str:
    r = f"  {label:<22}"
    for s in stats:
        r += f"{s['tf']:>{W}}"
    return r

def row(label: str, key: str, fmt: str = ".4f") -> str:
    r = f"  {label:<22}"
    for s in stats:
        cell = format(s[key], fmt)
        r += cell.rjust(W)
    return r

TF_ROW = f"  {'':22}" + "".join(f"{tf:>{W}}" for tf in TIMEFRAMES)

print(f"\n{SEP}")
print(f"  {SYMBOL}  ·  tick-built OHLCV  ·  {hours:.0f}h window")
print(SEP)
print(TF_ROW)
print(sep2)

print(f"\nBARS")
r = f"  {'count':<22}"
for s in stats: r += f"{s['bars']:>{W},}"
print(r)
r = f"  {'empty (no trades)':<22}"
for s in stats: r += f"{s['empty_bars']:>{W},}"
print(r)

print(f"\nPRICE  (close)")
print(row("  min",       "price_min",  ",.2f"))
print(row("  max",       "price_max",  ",.2f"))
print(row("  mean",      "price_mean", ",.2f"))
print(row("  std",       "price_std",  ",.4f"))

print(f"\nVOLATILITY")
print(row("  std / bar (%)", "vol_per_bar", ".5f"))
print(row("  ann vol (%)",   "ann_vol",     ".2f"))

print(f"\nLOG RETURNS  (%)")
print(row("  min",        "logret_min",  "+.4f"))
print(row("  max",        "logret_max",  "+.4f"))
print(row("  mean",       "logret_mean", "+.5f"))
print(row("  cumulative", "logret_cum",  "+.4f"))

print(f"\nMAX DRAWDOWN")
print(row("  max dd (%)",   "max_dd",     "+.3f"))
print(row("  peak price",   "peak_px",    ",.2f"))
print(row("  trough price", "trough_px",  ",.2f"))

print(f"\nVOLUME")
r = f"  {'total':<22}"
for s in stats: r += f"{s['volume_total']:>{W},.1f}"
print(r)

print(f"\n{SEP}")


# ── 5. Multi-lag autocorrelation ──────────────────────────────────────────────

LAGS = [1, 2, 3, 5, 10]

print(f"\nAUTOCORRELATION  (log returns)")
print(sep2)
print(TF_ROW)
print(sep2)

for lag in LAGS:
    r = f"  {'lag-' + str(lag):<22}"
    for tf in TIMEFRAMES:
        close   = bars[tf]["close"].dropna()
        log_ret = np.log(close / close.shift(1)).dropna()
        ac = log_ret.autocorr(lag=lag)
        cell = format(ac, "+.4f")
        r += cell.rjust(W)
    print(r)


# ── 6. Strong bars + win rate ─────────────────────────────────────────────────

print(f"\nSTRONG BARS  (|ret| > 2σ)  +  WIN RATE  (continuation next bar)")
print(sep2)

for tf in TIMEFRAMES:
    df      = bars[tf]
    close   = df["close"].dropna()
    log_ret = np.log(close / close.shift(1)).dropna()

    sigma     = log_ret.std()
    threshold = 2.0 * sigma
    strong    = log_ret[log_ret.abs() > threshold]

    if strong.empty:
        print(f"\n  [{tf}]  no strong bars")
        continue

    # direction of strong bar: +1 up, -1 down
    dirs = np.sign(strong)

    # next bar's return (shift -1 on log_ret aligned to strong index)
    next_ret = log_ret.shift(-1).reindex(strong.index)
    next_dir = np.sign(next_ret.dropna())
    dirs_aligned = dirs.reindex(next_dir.index)

    # continuation: next bar same direction as strong bar
    continuations = (dirs_aligned == next_dir).sum()
    total_with_next = len(next_dir)
    win_rate = continuations / total_with_next if total_with_next > 0 else float("nan")

    # split into up/down strong bars
    up_bars   = strong[strong > 0]
    down_bars = strong[strong < 0]

    # win rate for up strong bars
    def wr_split(sub):
        if sub.empty:
            return float("nan"), 0
        n_sub  = log_ret.shift(-1).reindex(sub.index).dropna()
        s_sub  = np.sign(sub).reindex(n_sub.index)
        cont   = (s_sub == np.sign(n_sub)).sum()
        return cont / len(n_sub), len(n_sub)

    wr_up,   n_up   = wr_split(up_bars)
    wr_down, n_down = wr_split(down_bars)

    print(f"\n  [{tf}]")
    print(f"    threshold      : {threshold*100:+.4f} %  (2σ)")
    print(f"    strong bars    : {len(strong)}  ({len(strong)/len(log_ret)*100:.1f}% of all bars)")
    print(f"    up / down      : {len(up_bars)} / {len(down_bars)}")
    print(f"    win rate (all) : {win_rate*100:.1f}%  (n={total_with_next})")
    print(f"    win rate  UP   : {wr_up*100:.1f}%  (n={n_up})")
    print(f"    win rate DOWN  : {wr_down*100:.1f}%  (n={n_down})")

    # show top 5 strongest
    top5 = strong.abs().nlargest(5).index
    print(f"    top-5 by size  :")
    for ts_i in top5:
        v = strong[ts_i]
        nr = log_ret.shift(-1).get(ts_i, float("nan"))
        cont_mark = "→ same" if not np.isnan(nr) and np.sign(nr) == np.sign(v) else "→ rev "
        print(f"      {ts_i}  ret={v*100:+.3f}%  next={nr*100:+.3f}%  {cont_mark}")


# ── 7. Rolling volatility ─────────────────────────────────────────────────────

print(f"\nROLLING VOLATILITY  (std of log returns over window)")
print(sep2)
print(TF_ROW)
print(sep2)

for window_label, window in [("  rvol-30 mean (%)", 30), ("  rvol-60 mean (%)", 60)]:
    r = f"  {window_label.strip():<22}"
    for tf in TIMEFRAMES:
        close   = bars[tf]["close"].dropna()
        log_ret = np.log(close / close.shift(1)).dropna()
        rvol    = log_ret.rolling(window).std() * 100
        cell    = format(rvol.mean(), ".5f")
        r += cell.rjust(W)
    print(r)

for window_label, window in [("  rvol-30 last (%)", 30), ("  rvol-60 last (%)", 60)]:
    r = f"  {window_label.strip():<22}"
    for tf in TIMEFRAMES:
        close   = bars[tf]["close"].dropna()
        log_ret = np.log(close / close.shift(1)).dropna()
        rvol    = log_ret.rolling(window).std() * 100
        cell    = format(rvol.iloc[-1], ".5f")
        r += cell.rjust(W)
    print(r)

# rolling vol regime: first vs last third
print(sep2)
print("  Rolling vol: first-third vs last-third of window")
for tf in TIMEFRAMES:
    close   = bars[tf]["close"].dropna()
    log_ret = np.log(close / close.shift(1)).dropna()
    n       = len(log_ret)
    third   = n // 3
    v_first = log_ret.iloc[:third].std() * 100
    v_last  = log_ret.iloc[-third:].std() * 100
    arrow   = "↑ rising" if v_last > v_first * 1.05 else ("↓ falling" if v_last < v_first * 0.95 else "→ stable")
    print(f"  [{tf}]  early={v_first:.5f}%  late={v_last:.5f}%  {arrow}")


# ── 8. Anomaly scan ───────────────────────────────────────────────────────────

print(f"\nANOMALY SCAN  (5σ spikes)")
print(sep2)

for s in stats:
    tf      = s["tf"]
    df      = bars[tf]
    close   = df["close"].dropna()
    log_ret = np.log(close / close.shift(1)).dropna()

    thresh  = log_ret.std() * 5
    spikes  = log_ret[log_ret.abs() > thresh]
    zero_runs = (df["volume"] == 0).astype(int)
    gap_count = (zero_runs.diff() == 1).sum()
    ac1     = log_ret.autocorr(lag=1)

    print(f"\n  [{tf}]")
    print(f"    5σ spikes      : {len(spikes)}  bars")
    if not spikes.empty:
        for ts_i, v in spikes.items():
            print(f"      {ts_i}  ret={v*100:+.3f}%")
    print(f"    empty-bar runs : {gap_count}")
    print(f"    autocorr lag-1 : {ac1:+.4f}  "
          f"({'mean-revert' if ac1 < -0.05 else 'momentum' if ac1 > 0.05 else 'neutral'})")

print(f"\n{SEP}\n")


# ── 9. Save CSV ───────────────────────────────────────────────────────────────

os.makedirs(OUT_DIR, exist_ok=True)

for tf in TIMEFRAMES:
    df      = bars[tf].copy()
    close   = df["close"]
    log_ret = np.log(close / close.shift(1))
    sigma   = log_ret.std()

    df["log_ret"]    = log_ret
    df["ret_pct"]    = close.pct_change() * 100
    df["rvol_30"]    = log_ret.rolling(30).std() * 100
    df["rvol_60"]    = log_ret.rolling(60).std() * 100
    df["strong_bar"] = log_ret.abs() > 2 * sigma
    df["direction"]  = np.sign(log_ret)

    fname = os.path.join(OUT_DIR, f"{SYMBOL}_{tf}.csv")
    df.to_csv(fname)
    print(f"  Saved: {fname}  ({len(df):,} rows)")

print()
