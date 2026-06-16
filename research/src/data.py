"""
Data loader — reads native01 parquet, reconstructs L2 book at each timestamp.

The native01 format (this repo's recorder):
  data/<env>/snapshot/<SYMBOL>/*.parquet  — full book snapshots
  data/<env>/delta/<SYMBOL>/*.parquet     — incremental updates (ABSOLUTE sizes, 0=remove)
  data/<env>/trade/<SYMBOL>/*.parquet     — recorded trades

Book levels are stored as JSON strings: '[[price, size], ...]'
All values are real units (no scaling).
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import duckdb
import polars as pl


@dataclass
class BookState:
    """Mutable L2 order book reconstructed from snapshots + deltas."""

    bids: dict[float, float] = field(default_factory=dict)
    asks: dict[float, float] = field(default_factory=dict)
    best_bid: float = float("-inf")
    best_ask: float = float("inf")
    ts: int = 0

    def clear(self) -> None:
        self.bids.clear()
        self.asks.clear()
        self.best_bid = float("-inf")
        self.best_ask = float("inf")

    def apply_snapshot(self, bids: list[list[float]], asks: list[list[float]], ts: int) -> None:
        self.clear()
        for p, s in bids:
            if s > 0:
                self.bids[p] = s
        for p, s in asks:
            if s > 0:
                self.asks[p] = s
        self._refresh_best()
        self.ts = ts

    def apply_delta(self, bids: list[list[float]], asks: list[list[float]], ts: int) -> None:
        for p, s in bids:
            if s <= 0:
                self.bids.pop(p, None)
            else:
                self.bids[p] = s
        for p, s in asks:
            if s <= 0:
                self.asks.pop(p, None)
            else:
                self.asks[p] = s
        self._refresh_best()
        self.ts = ts

    def mid(self) -> float | None:
        if self.best_bid == float("-inf") or self.best_ask == float("inf"):
            return None
        return (self.best_bid + self.best_ask) / 2

    def top_bids(self, n: int) -> list[tuple[float, float]]:
        """Top N bid levels, best (highest) first."""
        return sorted(self.bids.items(), key=lambda x: -x[0])[:n]

    def top_asks(self, n: int) -> list[tuple[float, float]]:
        """Top N ask levels, best (lowest) first."""
        return sorted(self.asks.items(), key=lambda x: x[0])[:n]

    def _refresh_best(self) -> None:
        self.best_bid = max(self.bids.keys()) if self.bids else float("-inf")
        self.best_ask = min(self.asks.keys()) if self.asks else float("inf")


@dataclass
class TradeEvent:
    ts: int
    side: str  # "bid" or "ask"
    price: float
    size: float


@dataclass
class MarketEvent:
    """A single time-ordered event from the parquet store."""

    kind: str  # "snapshot", "delta", "trade"
    ts: int
    bids: list[list[float]] | None = None
    asks: list[list[float]] | None = None
    trade: TradeEvent | None = None


def load_events(data_dir: str, env: str, symbol: str) -> list[MarketEvent]:
    """Load all events for a market from native01 parquet, time-sorted."""
    base = Path(data_dir) / env
    events: list[MarketEvent] = []

    con = duckdb.connect()

    snap_dir = base / "snapshot" / symbol
    if snap_dir.exists():
        snap_glob = str(snap_dir / "*.parquet")
        rows = con.execute(
            f"SELECT ts, bids, asks FROM read_parquet('{snap_glob}') ORDER BY ts"
        ).fetchall()
        for ts, bids_json, asks_json in rows:
            events.append(MarketEvent(
                kind="snapshot",
                ts=int(ts),
                bids=json.loads(bids_json),
                asks=json.loads(asks_json),
            ))

    delta_dir = base / "delta" / symbol
    if delta_dir.exists():
        delta_glob = str(delta_dir / "*.parquet")
        rows = con.execute(
            f"SELECT ts, bids, asks FROM read_parquet('{delta_glob}') ORDER BY ts"
        ).fetchall()
        for ts, bids_json, asks_json in rows:
            events.append(MarketEvent(
                kind="delta",
                ts=int(ts),
                bids=json.loads(bids_json),
                asks=json.loads(asks_json),
            ))

    trade_dir = base / "trade" / symbol
    if trade_dir.exists():
        trade_glob = str(trade_dir / "*.parquet")
        rows = con.execute(
            f"SELECT ts, side, price, size FROM read_parquet('{trade_glob}') ORDER BY ts"
        ).fetchall()
        for ts, side, price, size in rows:
            events.append(MarketEvent(
                kind="trade",
                ts=int(ts),
                trade=TradeEvent(ts=int(ts), side=side, price=price, size=size),
            ))

    con.close()
    events.sort(key=lambda e: e.ts)
    return events


def replay_book(events: list[MarketEvent]) -> Iterator[tuple[BookState, MarketEvent]]:
    """
    Replay events, yielding (current_book_state, event) for each event.

    The BookState is mutated in-place — snapshot it if you need history.
    PIT-correct: the book reflects state AFTER applying the event.
    """
    book = BookState()
    for ev in events:
        if ev.kind == "snapshot":
            book.apply_snapshot(ev.bids, ev.asks, ev.ts)
        elif ev.kind == "delta":
            book.apply_delta(ev.bids, ev.asks, ev.ts)
        elif ev.kind == "trade":
            book.ts = ev.ts
        yield book, ev


class TradeWindow:
    """Rolling window of recent trades for trade-flow features."""

    def __init__(self, max_window_ms: int = 300_000):
        self.max_window_ms = max_window_ms
        self._trades: list[TradeEvent] = []

    def add(self, t: TradeEvent) -> None:
        self._trades.append(t)

    def prune(self, now: int) -> None:
        cutoff = now - self.max_window_ms
        while self._trades and self._trades[0].ts < cutoff:
            self._trades.pop(0)

    def trades_in_window(self, now: int, window_ms: int) -> list[TradeEvent]:
        cutoff = now - window_ms
        return [t for t in self._trades if t.ts >= cutoff]

    def all_trades(self) -> list[TradeEvent]:
        return self._trades


class MidHistory:
    """Rolling buffer of (ts, mid) for return/volatility features."""

    def __init__(self, max_window_ms: int = 300_000):
        self.max_window_ms = max_window_ms
        self._entries: list[tuple[int, float]] = []

    def add(self, ts: int, mid: float) -> None:
        self._entries.append((ts, mid))

    def prune(self, now: int) -> None:
        cutoff = now - self.max_window_ms
        while self._entries and self._entries[0][0] < cutoff:
            self._entries.pop(0)

    def mid_at_or_before(self, target_ts: int) -> float | None:
        """Find the mid closest to (but not after) target_ts."""
        result = None
        for ts, mid in self._entries:
            if ts <= target_ts:
                result = mid
            else:
                break
        return result

    def mid_at_or_after(self, target_ts: int) -> float | None:
        """Find the first mid at or after target_ts."""
        for ts, mid in self._entries:
            if ts >= target_ts:
                return mid
        return None

    def mids_in_window(self, now: int, window_ms: int) -> list[tuple[int, float]]:
        cutoff = now - window_ms
        return [(ts, m) for ts, m in self._entries if ts >= cutoff]
