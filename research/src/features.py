"""
Feature computation — pure functions over BookState + TradeWindow + MidHistory.

Every function matches the spec in research/spec/features.json. The TS inference
adapter (src/research/inference/features.ts) implements the same formulas — the
parity test verifies they produce identical output.
"""

import math

from .data import BookState, TradeWindow, MidHistory


# ── Microstructure (book-only) ───────────────────────────────────────────────


def spread_bps(book: BookState) -> float:
    mid = book.mid()
    if mid is None or mid == 0:
        return 0.0
    return (book.best_ask - book.best_bid) / mid * 10_000


def microprice(book: BookState) -> float:
    tb = book.top_bids(1)
    ta = book.top_asks(1)
    if not tb or not ta:
        return 0.0
    bid_p, bid_s = tb[0]
    ask_p, ask_s = ta[0]
    total = bid_s + ask_s
    if total == 0:
        return 0.0
    return (bid_p * ask_s + ask_p * bid_s) / total


def book_imbalance(book: BookState, levels: int = 1) -> float:
    bids = book.top_bids(levels)
    asks = book.top_asks(levels)
    bid_qty = sum(s for _, s in bids)
    ask_qty = sum(s for _, s in asks)
    total = bid_qty + ask_qty
    if total == 0:
        return 0.0
    return (bid_qty - ask_qty) / total


def depth_bid(book: BookState, levels: int = 5) -> float:
    return sum(s for _, s in book.top_bids(levels))


def depth_ask(book: BookState, levels: int = 5) -> float:
    return sum(s for _, s in book.top_asks(levels))


def depth_ratio(book: BookState, levels: int = 5) -> float:
    d_ask = depth_ask(book, levels)
    if d_ask == 0:
        return 0.0
    return depth_bid(book, levels) / d_ask


def wap_distance_bps(book: BookState, levels: int = 5) -> float:
    """Effective spread of top-N depth measured as VWAP distance in bps."""
    mid = book.mid()
    if mid is None or mid == 0:
        return 0.0

    bids = book.top_bids(levels)
    asks = book.top_asks(levels)

    bid_notional = sum(p * s for p, s in bids)
    bid_qty = sum(s for _, s in bids)
    ask_notional = sum(p * s for p, s in asks)
    ask_qty = sum(s for _, s in asks)

    if bid_qty == 0 or ask_qty == 0:
        return 0.0

    vwap_bid = bid_notional / bid_qty
    vwap_ask = ask_notional / ask_qty
    return (vwap_ask - vwap_bid) / mid * 10_000


# ── Trade flow (requires TradeWindow) ────────────────────────────────────────


def trade_imbalance(tw: TradeWindow, now: int, window_ms: int = 60_000) -> float:
    trades = tw.trades_in_window(now, window_ms)
    if not trades:
        return 0.0
    buy_vol = sum(t.size for t in trades if t.side == "bid")
    sell_vol = sum(t.size for t in trades if t.side == "ask")
    total = buy_vol + sell_vol
    if total == 0:
        return 0.0
    return (buy_vol - sell_vol) / total


def trade_intensity(tw: TradeWindow, now: int, window_ms: int = 60_000) -> float:
    trades = tw.trades_in_window(now, window_ms)
    if window_ms == 0:
        return 0.0
    return len(trades) / (window_ms / 1000)


def avg_trade_size(tw: TradeWindow, now: int, window_ms: int = 60_000) -> float:
    trades = tw.trades_in_window(now, window_ms)
    if not trades:
        return 0.0
    return sum(t.size for t in trades) / len(trades)


def ofi(tw: TradeWindow, now: int, window_ms: int = 60_000) -> float:
    """
    Order flow imbalance: net signed trade volume.

    Positive = net buying pressure; negative = net selling pressure.
    Normalized by total volume to be scale-independent.
    """
    trades = tw.trades_in_window(now, window_ms)
    if not trades:
        return 0.0
    signed = sum(t.size if t.side == "bid" else -t.size for t in trades)
    total = sum(t.size for t in trades)
    if total == 0:
        return 0.0
    return signed / total


# ── Volatility (requires MidHistory) ─────────────────────────────────────────


def realized_vol(mh: MidHistory, now: int, window_ms: int = 300_000) -> float:
    """Realized volatility from mid returns, annualized."""
    entries = mh.mids_in_window(now, window_ms)
    if len(entries) < 2:
        return 0.0
    log_returns = []
    for i in range(1, len(entries)):
        if entries[i - 1][1] > 0 and entries[i][1] > 0:
            log_returns.append(math.log(entries[i][1] / entries[i - 1][1]))
    if len(log_returns) < 2:
        return 0.0
    mean = sum(log_returns) / len(log_returns)
    var = sum((r - mean) ** 2 for r in log_returns) / (len(log_returns) - 1)
    # Annualize: assume entries are ~1s apart, scale by sqrt(seconds_per_year)
    dt_avg = (entries[-1][0] - entries[0][0]) / max(len(entries) - 1, 1) / 1000
    if dt_avg <= 0:
        return 0.0
    periods_per_year = 365.25 * 24 * 3600 / dt_avg
    return math.sqrt(var * periods_per_year)


def log_return(mh: MidHistory, now: int, window_ms: int = 10_000) -> float:
    """Log return of mid over window."""
    current = mh.mid_at_or_before(now)
    past = mh.mid_at_or_before(now - window_ms)
    if current is None or past is None or past <= 0 or current <= 0:
        return 0.0
    return math.log(current / past)


# ── Compute all features ─────────────────────────────────────────────────────


def compute_all(
    book: BookState,
    tw: TradeWindow,
    mh: MidHistory,
    now: int,
) -> dict[str, float]:
    """Compute the full feature vector. Keys match research/spec/features.json names."""
    return {
        "spread_bps": spread_bps(book),
        "microprice": microprice(book),
        "book_imbalance_1": book_imbalance(book, levels=1),
        "book_imbalance_5": book_imbalance(book, levels=5),
        "depth_bid_5": depth_bid(book, levels=5),
        "depth_ask_5": depth_ask(book, levels=5),
        "depth_ratio_5": depth_ratio(book, levels=5),
        "wap_distance_bps": wap_distance_bps(book, levels=5),
        "trade_imbalance_60s": trade_imbalance(tw, now, 60_000),
        "trade_intensity_60s": trade_intensity(tw, now, 60_000),
        "avg_trade_size_60s": avg_trade_size(tw, now, 60_000),
        "ofi_60s": ofi(tw, now, 60_000),
        "realized_vol_300s": realized_vol(mh, now, 300_000),
        "return_10s": log_return(mh, now, 10_000),
        "return_60s": log_return(mh, now, 60_000),
    }


FEATURE_NAMES = list(compute_all.__code__.co_consts)  # not used at runtime
FEATURE_NAMES = [
    "spread_bps", "microprice", "book_imbalance_1", "book_imbalance_5",
    "depth_bid_5", "depth_ask_5", "depth_ratio_5", "wap_distance_bps",
    "trade_imbalance_60s", "trade_intensity_60s", "avg_trade_size_60s",
    "ofi_60s", "realized_vol_300s", "return_10s", "return_60s",
]
