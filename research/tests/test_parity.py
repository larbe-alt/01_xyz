"""
Parity test — verifies Python and TS feature computers produce identical output
on the same synthetic input.

This is the integrity guarantee: if this test passes, the model sees in
production (TS) exactly what it trained on (Python).

Run: cd research && python -m pytest tests/test_parity.py -v
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.data import BookState, TradeWindow, MidHistory, TradeEvent
from src.features import compute_all

REPO_ROOT = Path(__file__).resolve().parents[2]
TS_PARITY_SCRIPT = REPO_ROOT / "src" / "research" / "inference" / "parity-check.ts"


def make_test_case() -> dict:
    """Build a deterministic test fixture shared between Python and TS."""
    return {
        "book": {
            "bids": [[2000.0, 10.0], [1999.5, 20.0], [1999.0, 30.0], [1998.5, 15.0], [1998.0, 25.0]],
            "asks": [[2000.5, 8.0], [2001.0, 18.0], [2001.5, 22.0], [2002.0, 12.0], [2002.5, 35.0]],
        },
        "trades": [
            {"ts": 99_000, "side": "bid", "price": 2000.5, "size": 1.5},
            {"ts": 99_200, "side": "ask", "price": 2000.0, "size": 0.8},
            {"ts": 99_500, "side": "bid", "price": 2000.5, "size": 2.0},
            {"ts": 99_700, "side": "bid", "price": 2001.0, "size": 0.3},
            {"ts": 99_900, "side": "ask", "price": 1999.5, "size": 1.2},
        ],
        "mids": [
            {"ts": 30_000, "mid": 1998.0},
            {"ts": 40_000, "mid": 1999.0},
            {"ts": 50_000, "mid": 2000.0},
            {"ts": 60_000, "mid": 2000.5},
            {"ts": 70_000, "mid": 2001.0},
            {"ts": 80_000, "mid": 2000.0},
            {"ts": 90_000, "mid": 2000.25},
            {"ts": 100_000, "mid": 2000.25},
        ],
        "now": 100_000,
    }


def compute_python_features(tc: dict) -> dict[str, float]:
    """Compute features using the Python implementation."""
    book = BookState()
    for p, s in tc["book"]["bids"]:
        book.bids[p] = s
    for p, s in tc["book"]["asks"]:
        book.asks[p] = s
    book._refresh_best()
    book.ts = tc["now"]

    tw = TradeWindow(max_window_ms=300_000)
    for t in tc["trades"]:
        tw.add(TradeEvent(ts=t["ts"], side=t["side"], price=t["price"], size=t["size"]))

    mh = MidHistory(max_window_ms=300_000)
    for m in tc["mids"]:
        mh.add(m["ts"], m["mid"])

    return compute_all(book, tw, mh, tc["now"])


def test_python_features_smoke():
    """Sanity check: Python features compute without error and have expected keys."""
    tc = make_test_case()
    feats = compute_python_features(tc)

    expected_keys = {
        "spread_bps", "microprice", "book_imbalance_1", "book_imbalance_5",
        "depth_bid_5", "depth_ask_5", "depth_ratio_5", "wap_distance_bps",
        "trade_imbalance_60s", "trade_intensity_60s", "avg_trade_size_60s",
        "ofi_60s", "realized_vol_300s", "return_10s", "return_60s",
    }
    assert set(feats.keys()) == expected_keys

    # Basic sanity
    assert feats["spread_bps"] > 0, "spread should be positive"
    assert -1 <= feats["book_imbalance_1"] <= 1, "imbalance should be in [-1, 1]"
    assert feats["depth_bid_5"] > 0
    assert feats["depth_ask_5"] > 0


def test_python_ts_parity():
    """
    Cross-language parity: compute features in Python and TS on the same input,
    assert they match within floating-point tolerance.
    """
    if not TS_PARITY_SCRIPT.exists():
        pytest.skip(f"TS parity script not found: {TS_PARITY_SCRIPT}")

    tc = make_test_case()
    py_feats = compute_python_features(tc)

    # Run TS parity check
    result = subprocess.run(
        ["npx", "tsx", str(TS_PARITY_SCRIPT), json.dumps(tc)],
        capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=30,
    )
    if result.returncode != 0:
        pytest.fail(f"TS parity script failed:\nstdout: {result.stdout}\nstderr: {result.stderr}")

    ts_feats = json.loads(result.stdout.strip())

    # Compare each feature
    tol = 1e-9
    mismatches = []
    for key in py_feats:
        py_val = py_feats[key]
        ts_val = ts_feats.get(key)
        if ts_val is None:
            mismatches.append(f"  {key}: missing in TS output")
        elif abs(py_val - ts_val) > tol:
            mismatches.append(f"  {key}: py={py_val:.12f} ts={ts_val:.12f} diff={abs(py_val - ts_val):.2e}")

    if mismatches:
        pytest.fail("Feature parity failures:\n" + "\n".join(mismatches))
