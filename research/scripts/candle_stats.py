"""
Candle stats from local parquet data.
Uses: data/mainnet/candle/ETHUSD, data/mainnet/mark/ETHUSD
"""

import glob
import numpy as np
import pandas as pd

SYMBOL    = "ETHUSD"
CANDLE_DIR = f"data/mainnet/candle/{SYMBOL}"
MARK_DIR   = f"data/mainnet/mark/{SYMBOL}"
N_CANDLES  = 1000  # last N 1-min candles


# ── 1. Load candles ──────────────────────────────────────────────────────────

candle_files = sorted(glob.glob(f"{CANDLE_DIR}/*.parquet"))
if not candle_files:
    raise FileNotFoundError(f"No candle parquets in {CANDLE_DIR}")

raw = pd.concat([pd.read_parquet(f) for f in candle_files], ignore_index=True)
raw["ts"] = pd.to_datetime(raw["ts"], unit="ms", utc=True)

candles = (
    raw[raw["resolution"] == "1"]
    .drop_duplicates("ts")
    .sort_values("ts")
    .tail(N_CANDLES)
    .reset_index(drop=True)
)

print(f"Loaded {len(candles)} 1-min candles  "
      f"{candles['ts'].iloc[0]}  →  {candles['ts'].iloc[-1]}")


# ── 2. Returns ────────────────────────────────────────────────────────────────

close = candles["c"]

candles["ret"]     = close.pct_change()                    # simple return
candles["log_ret"] = np.log(close / close.shift(1))        # log return

ret     = candles["ret"].dropna()
log_ret = candles["log_ret"].dropna()


# ── 3. Maximum drawdown ───────────────────────────────────────────────────────

rolling_max = close.cummax()
drawdown    = (close - rolling_max) / rolling_max          # negative series
max_dd      = drawdown.min()                               # worst point

# when did the drawdown peak-to-trough happen?
trough_idx = drawdown.idxmin()
peak_idx   = rolling_max[:trough_idx].idxmax()
peak_price  = close[peak_idx]
trough_price = close[trough_idx]


# ── 4. Load mark / funding ────────────────────────────────────────────────────

mark_files = sorted(glob.glob(f"{MARK_DIR}/*.parquet"))
funding_stats = None

if mark_files:
    mark_raw = pd.concat([pd.read_parquet(f) for f in mark_files], ignore_index=True)
    mark_raw["ts"] = pd.to_datetime(mark_raw["ts"], unit="ms", utc=True)
    mark = mark_raw.drop_duplicates("ts").sort_values("ts")
    mark["funding_hourly"] = mark["funding_rate"] / 8

    t0, t1 = candles["ts"].iloc[0], candles["ts"].iloc[-1]
    win = mark[(mark["ts"] >= t0) & (mark["ts"] <= t1)]

    if not win.empty:
        funding_stats = {
            "mean_8h_rate_%":     win["funding_rate"].mean() * 100,
            "last_8h_rate_%":     win["funding_rate"].iloc[-1] * 100,
            "ann_funding_%":      win["funding_hourly"].mean() * 8760 * 100,
            "last_mark_price":    win["mark_price"].iloc[-1],
            "last_open_interest": win["open_interest"].iloc[-1],
        }


# ── 5. Hourly resample ────────────────────────────────────────────────────────

hourly = (
    candles.set_index("ts")
    .resample("1h")
    .agg(open=("o", "first"), high=("h", "max"), low=("l", "min"),
         close=("c", "last"), volume=("vol", "sum"))
    .dropna()
)


# ── 6. Print ──────────────────────────────────────────────────────────────────

SEP  = "═" * 56
sep2 = "─" * 56

ann_factor = np.sqrt(525_600)   # 1-min bars in a year

print(f"\n{SEP}")
print(f"  {SYMBOL}  ·  last {len(candles)} 1-min candles")
print(SEP)

# --- Price basic stats
print(f"\n{'PRICE (close)  —  min / max / mean / std':}")
print(sep2)
print(f"  min           : {close.min():>12,.4f}")
print(f"  max           : {close.max():>12,.4f}")
print(f"  mean          : {close.mean():>12,.4f}")
print(f"  std           : {close.std():>12,.4f}")
print(f"  last          : {close.iloc[-1]:>12,.4f}")

# --- Volatility
print(f"\n{'VOLATILITY  (std of 1-min returns)':}")
print(sep2)
std_ret = ret.std()
ann_vol = std_ret * ann_factor
print(f"  std ret/bar   : {std_ret*100:>11.5f} %   ← spread on a typical 1-min bar")
print(f"  ann vol       : {ann_vol*100:>11.2f} %   ← annualised (×√525600)")

# --- Log returns
print(f"\n{'LOG RETURNS  (1-min)':}")
print(sep2)
print(f"  min           : {log_ret.min()*100:>+11.5f} %")
print(f"  max           : {log_ret.max()*100:>+11.5f} %")
print(f"  mean          : {log_ret.mean()*100:>+11.5f} %")
print(f"  std           : {log_ret.std()*100:>11.5f} %")
cumlog = log_ret.sum()
print(f"  cumulative    : {cumlog*100:>+11.4f} %   ← total log-return over window")

# --- Drawdown
print(f"\n{'MAX DRAWDOWN':}")
print(sep2)
print(f"  max drawdown  : {max_dd*100:>+11.4f} %")
print(f"  peak price    : {peak_price:>12,.4f}  at {candles['ts'][peak_idx]}")
print(f"  trough price  : {trough_price:>12,.4f}  at {candles['ts'][trough_idx]}")
print(f"  drop          : {(trough_price - peak_price):>+12,.4f}")

# --- Funding
if funding_stats:
    print(f"\n{'FUNDING  (from mark stream)':}")
    print(sep2)
    print(f"  last 8h rate  : {funding_stats['last_8h_rate_%']:>+11.6f} %")
    print(f"  mean 8h rate  : {funding_stats['mean_8h_rate_%']:>+11.6f} %")
    print(f"  ann funding   : {funding_stats['ann_funding_%']:>+11.2f} %")
    print(f"  last mark px  : {funding_stats['last_mark_price']:>12,.4f}")
    print(f"  open interest : {funding_stats['last_open_interest']:>12,.4f}")
else:
    print("\nFUNDING: no mark data in window")

# --- Hourly tail
print(f"\n{'HOURLY BARS  (last 5)':}")
print(sep2)
print(hourly[["open","high","low","close","volume"]].tail(5).to_string())

print(f"\n{SEP}\n")
