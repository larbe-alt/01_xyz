"""
Regime / state analysis on tick-built OHLCV bars.

States (by log_ret):
  Strong_Up   : log_ret > +0.005  ( > +0.5%)
  Strong_Down : log_ret < -0.005  ( < -0.5%)
  Calm        : |log_ret| < 0.002  (< 0.2%)
  Normal      : everything else

Outputs per TF:
  - CSV with 'state' column appended
  - Transition matrix (prob) printed + saved as CSV
  - Next-bar return stats after each state
  - Heatmap plot saved to research/output/
"""

import os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")  # no display needed
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
from matplotlib.colors import LinearSegmentedColormap

SYMBOL    = "ETHUSD"
IN_DIR    = "research/output"
OUT_DIR   = "research/output"
TIMEFRAMES = ["5s", "10s", "15s", "30s", "1min"]

# ── Threshold mode ────────────────────────────────────────────────────────────
# False → fixed constants below (original behaviour)
# True  → derived per-TF from the actual return distribution (μ ± N·σ)
ADAPTIVE_THRESHOLDS = True

SIGMA_STRONG = 2.0   # |log_ret| > μ ± 2σ  → Strong_Up / Strong_Down
SIGMA_CALM   = 0.5   # |log_ret| < 0.5σ    → Calm

# Fixed fallback (used when ADAPTIVE_THRESHOLDS = False)
T_STRONG_UP   =  0.005   # +0.5%
T_STRONG_DOWN = -0.005   # -0.5%
T_CALM        =  0.002   # ±0.2%

STATES = ["Strong_Down", "Normal_Down", "Calm", "Normal_Up", "Strong_Up"]
# ordered from most negative to most positive for clean matrix layout

os.makedirs(OUT_DIR, exist_ok=True)


# ── helpers ───────────────────────────────────────────────────────────────────

def classify(log_ret: float,
             t_strong_up: float, t_strong_down: float, t_calm: float) -> str:
    if np.isnan(log_ret):
        return np.nan
    if log_ret > t_strong_up:
        return "Strong_Up"
    if log_ret < t_strong_down:
        return "Strong_Down"
    if abs(log_ret) < t_calm:
        return "Calm"
    if log_ret > 0:
        return "Normal_Up"
    return "Normal_Down"


def transition_matrix(states: pd.Series) -> pd.DataFrame:
    """Count transitions s[t] → s[t+1] and normalise to probabilities."""
    s  = states.dropna()
    df = pd.DataFrame({"from": s.values[:-1], "to": s.values[1:]})
    counts = (
        df.groupby(["from", "to"])
        .size()
        .unstack(fill_value=0)
        .reindex(index=STATES, columns=STATES, fill_value=0)
    )
    # row-normalise → probability
    prob = counts.div(counts.sum(axis=1), axis=0).fillna(0)
    return prob, counts


def next_bar_stats(df: pd.DataFrame) -> pd.DataFrame:
    """
    For each state, compute stats of the *next bar's* log_ret.
    Returns a DataFrame indexed by state.
    """
    df = df.copy()
    df["next_log_ret"] = df["log_ret"].shift(-1)
    rows = []
    for state in STATES:
        sub = df[df["state"] == state]["next_log_ret"].dropna()
        if sub.empty:
            rows.append({"state": state, "n": 0,
                         "mean_%": np.nan, "std_%": np.nan,
                         "win_rate": np.nan, "median_%": np.nan})
            continue
        rows.append({
            "state"    : state,
            "n"        : len(sub),
            "mean_%"   : sub.mean() * 100,
            "median_%" : sub.median() * 100,
            "std_%"    : sub.std() * 100,
            "win_rate" : (sub > 0).mean() * 100,  # % of next bars > 0
        })
    return pd.DataFrame(rows).set_index("state").reindex(STATES)


def plot_heatmap(prob: pd.DataFrame, counts: pd.DataFrame,
                 tf: str, out_path: str):
    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    # custom diverging cmap: low=blue, mid=white, high=red
    cmap = LinearSegmentedColormap.from_list(
        "bwr2", ["#2166ac", "#f7f7f7", "#d6604d"], N=256
    )

    for ax, data, title, fmt in [
        (axes[0], prob,   "Transition Probability",   ".2f"),
        (axes[1], counts, "Transition Count",         "d"),
    ]:
        im = ax.imshow(data.values, cmap=cmap, aspect="auto",
                       vmin=0, vmax=(1.0 if fmt == ".2f" else counts.values.max()))
        ax.set_xticks(range(len(STATES)))
        ax.set_yticks(range(len(STATES)))
        ax.set_xticklabels(STATES, rotation=35, ha="right", fontsize=9)
        ax.set_yticklabels(STATES, fontsize=9)
        ax.set_xlabel("To state  (t+1)", fontsize=10)
        ax.set_ylabel("From state  (t)", fontsize=10)
        ax.set_title(f"{title}\n{SYMBOL}  [{tf}]", fontsize=11, fontweight="bold")

        # annotate each cell
        for i in range(len(STATES)):
            for j in range(len(STATES)):
                val = data.values[i, j]
                text = format(val, fmt)
                bg_intensity = val / (1.0 if fmt == ".2f" else max(counts.values.max(), 1))
                color = "white" if bg_intensity > 0.55 else "black"
                ax.text(j, i, text, ha="center", va="center",
                        fontsize=8, color=color, fontweight="bold")

        plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)

    plt.tight_layout()
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()
    print(f"    Saved plot: {out_path}")


# ── main loop ─────────────────────────────────────────────────────────────────

SEP  = "═" * 72
sep2 = "─" * 72

all_trans_prob   = {}   # tf → transition prob DataFrame
all_next_stats   = {}   # tf → next-bar stats DataFrame

for tf in TIMEFRAMES:
    csv_in  = os.path.join(IN_DIR,  f"{SYMBOL}_{tf}.csv")
    csv_out = os.path.join(OUT_DIR, f"{SYMBOL}_{tf}_regime.csv")

    df = pd.read_csv(csv_in, parse_dates=["ts"], index_col="ts")

    # ── threshold selection ───────────────────────────────────────────────────
    if ADAPTIVE_THRESHOLDS:
        mu  = df["log_ret"].mean()
        sig = df["log_ret"].std()
        t_strong_up   = mu + SIGMA_STRONG * sig
        t_strong_down = mu - SIGMA_STRONG * sig
        t_calm        = SIGMA_CALM * sig
        thresh_label  = (f"adaptive  μ={mu*100:+.4f}%  σ={sig*100:.4f}%  "
                         f"strong=±{SIGMA_STRONG}σ  calm=±{SIGMA_CALM}σ")
    else:
        t_strong_up, t_strong_down, t_calm = T_STRONG_UP, T_STRONG_DOWN, T_CALM
        thresh_label  = (f"fixed  strong±={T_STRONG_UP*100:.3f}%  "
                         f"calm±={T_CALM*100:.3f}%")

    df["state"] = df["log_ret"].apply(
        classify, t_strong_up=t_strong_up, t_strong_down=t_strong_down, t_calm=t_calm
    )

    print(f"\n{SEP}")
    print(f"  [{tf}]  {len(df):,} bars  |  thresholds: {thresh_label}")
    print(SEP)

    # state distribution
    counts_dist = df["state"].value_counts().reindex(STATES, fill_value=0)
    total = counts_dist.sum()
    print(f"\nSTATE DISTRIBUTION")
    print(sep2)
    for st, cnt in counts_dist.items():
        bar_w = int(cnt / total * 40)
        print(f"  {st:<14} {cnt:>6,}  ({cnt/total*100:5.1f}%)  {'█'*bar_w}")

    # transition matrix
    prob, cnt_mat = transition_matrix(df["state"])
    all_trans_prob[tf] = prob

    print(f"\nTRANSITION MATRIX  (row=from, col=to, values=prob)")
    print(sep2)
    from_to = "FROM \\ TO"
    header = f"  {from_to:<14}" + "".join(f"{s:>14}" for s in STATES)
    print(header)
    print(sep2)
    for from_state in STATES:
        row_str = f"  {from_state:<14}"
        for to_state in STATES:
            p = prob.loc[from_state, to_state]
            # highlight if > 0.4 (dominant)
            marker = " *" if p > 0.40 else "  "
            row_str += f"{p:>12.3f}{marker}"
        print(row_str)

    # self-persistence (diagonal)
    print(f"\n  Persistence (stay in same state):")
    for st in STATES:
        p = prob.loc[st, st]
        print(f"    {st:<14} {p:.3f}")

    # next-bar stats
    nbs = next_bar_stats(df)
    all_next_stats[tf] = nbs

    print(f"\nNEXT-BAR STATS  (return of bar t+1 after state at bar t)")
    print(sep2)
    print(f"  {'State':<14}  {'n':>6}  {'mean%':>8}  {'median%':>9}  {'std%':>8}  {'win%':>7}")
    print(sep2)
    for st in STATES:
        r = nbs.loc[st]
        if np.isnan(r["mean_%"]):
            print(f"  {st:<14}  {'—':>6}")
            continue
        flag = ""
        if abs(r["mean_%"]) > 0.01:   flag = "  ← edge"
        if r["win_rate"] > 55:         flag = "  ← bullish follow"
        if r["win_rate"] < 45:         flag = "  ← bearish follow"
        print(f"  {st:<14}  {int(r['n']):>6,}  {r['mean_%']:>+8.4f}  "
              f"{r['median_%']:>+9.4f}  {r['std_%']:>8.4f}  {r['win_rate']:>6.1f}%{flag}")

    # key transitions: highest-return next bars
    print(f"\nKEY TRANSITIONS  (|mean next-bar| ranked)")
    print(sep2)
    ranked = nbs.dropna().reindex(columns=["mean_%","win_rate","n"]).sort_values(
        "mean_%", key=abs, ascending=False
    )
    for st, r in ranked.iterrows():
        direction = "→ UP  " if r["mean_%"] > 0 else "→ DOWN"
        print(f"  After {st:<14}  {direction}  mean={r['mean_%']:+.4f}%  "
              f"win={r['win_rate']:.1f}%  n={int(r['n'])}")

    # plot
    plot_path = os.path.join(OUT_DIR, f"{SYMBOL}_{tf}_transition.png")
    plot_heatmap(prob, cnt_mat, tf, plot_path)

    # save enriched CSV
    df.to_csv(csv_out)
    print(f"  Saved: {csv_out}")


# ── cross-TF summary ──────────────────────────────────────────────────────────

print(f"\n\n{SEP}")
print(f"  CROSS-TF SUMMARY  —  win rate after Strong_Down (next bar > 0)")
print(SEP)
print(f"  {'TF':<8}  {'n':>6}  {'mean_next%':>12}  {'win_rate':>10}")
print(sep2)
for tf in TIMEFRAMES:
    nbs = all_next_stats[tf]
    r   = nbs.loc["Strong_Down"]
    if np.isnan(r["mean_%"]):
        print(f"  {tf:<8}  —")
    else:
        print(f"  {tf:<8}  {int(r['n']):>6,}  {r['mean_%']:>+12.4f}%  {r['win_rate']:>9.1f}%")

print()
print(f"  CROSS-TF SUMMARY  —  win rate after Strong_Up")
print(sep2)
print(f"  {'TF':<8}  {'n':>6}  {'mean_next%':>12}  {'win_rate':>10}")
print(sep2)
for tf in TIMEFRAMES:
    nbs = all_next_stats[tf]
    r   = nbs.loc["Strong_Up"]
    if np.isnan(r["mean_%"]):
        print(f"  {tf:<8}  —")
    else:
        print(f"  {tf:<8}  {int(r['n']):>6,}  {r['mean_%']:>+12.4f}%  {r['win_rate']:>9.1f}%")

print(f"\n{SEP}\n")
