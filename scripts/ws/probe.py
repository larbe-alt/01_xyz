"""
ws_probe.py — 01 Exchange WebSocket behaviour probe
=====================================================
Runs two experiments back-to-back and prints timestamped observations:

  EXP-A  Default websockets settings (lib-level heartbeat ON)
         Expected: server closes with 1011 within ~30 s

  EXP-B  ping_interval=None + data-stream liveness (CORRECT approach)
         Expected: stable; times out only when no data for LIVENESS_TIMEOUT

Usage:
    python3 ws_probe.py            # both experiments
    python3 ws_probe.py --exp a    # only EXP-A (danger: will get killed by server)
    python3 ws_probe.py --exp b    # only EXP-B (stable)
    python3 ws_probe.py --stream deltas@BTCUSD   # override stream
"""

import asyncio
import json
import sys
import time
import argparse
from datetime import datetime, timezone

import websockets

# ── config ────────────────────────────────────────────────────────────────────
HOST          = "wss://zo-mainnet.n1.xyz"
STREAM        = "deltas@BTCUSD"        # always-on canary; change via --stream
LIVENESS_TIMEOUT = 15.0                # seconds of silence before reconnect
EXP_A_TIMEOUT    = 90.0               # how long to keep EXP-A alive (server kills sooner)
EXP_B_DURATION   = 60.0               # how long to run EXP-B (set 0 for infinite)
MAX_RECONNECTS   = 5

def ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3] + "Z"

def log(tag: str, msg: str):
    print(f"[{ts()}] [{tag}] {msg}", flush=True)


# ── EXP-A: default settings (lib heartbeat ON) ────────────────────────────────
async def experiment_a(uri: str):
    """
    Connect with default websockets settings.
    The library sends WebSocket ping frames; 01's server ignores them and
    closes the connection with code 1011 (internal error / keepalive failure).
    """
    log("EXP-A", f"Connecting to {uri} with DEFAULT settings (ping_interval=20s)")
    log("EXP-A", "Expect: server closes with code 1011 within ~30 s")

    msg_count = 0
    t0 = time.monotonic()

    try:
        # websockets default: ping_interval=20, ping_timeout=20
        async with websockets.connect(uri) as ws:
            log("EXP-A", "Connected")
            while True:
                elapsed = time.monotonic() - t0
                if elapsed > EXP_A_TIMEOUT:
                    log("EXP-A", f"Reached {EXP_A_TIMEOUT}s limit — server did NOT kill us yet (unexpected)")
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    msg_count += 1
                    if msg_count <= 3 or msg_count % 50 == 0:
                        data = json.loads(raw)
                        log("EXP-A", f"msg #{msg_count}: type={data.get('type') or data.get('stream', '?')} update_id={data.get('update_id', '?')}")
                except asyncio.TimeoutError:
                    log("EXP-A", f"No data for 5 s (msg so far: {msg_count})")

    except websockets.exceptions.ConnectionClosedError as e:
        elapsed = round(time.monotonic() - t0, 2)
        log("EXP-A", f"CLOSED by server after {elapsed}s — code={e.code} reason={e.reason!r}")
        if e.code == 1011:
            log("EXP-A", "=> CONFIRMED 1011: server killed lib-level ping. Use ping_interval=None.")
        else:
            log("EXP-A", f"=> Unexpected close code {e.code}")
    except Exception as e:
        log("EXP-A", f"ERROR: {type(e).__name__}: {e}")

    log("EXP-A", f"Done. Total messages received: {msg_count}")


# ── EXP-B: correct approach — no lib heartbeat, data-stream liveness ──────────
async def experiment_b(uri: str, duration: float = EXP_B_DURATION):
    """
    Connect with ping_interval=None (no lib-level heartbeat).
    Liveness is inferred from the data stream: if recv() times out for
    LIVENESS_TIMEOUT seconds we assume the connection is dead and reconnect.

    'deltas@BTCUSD' ticks every time the orderbook changes and is the best
    canary — always active while the market is open.
    """
    log("EXP-B", f"Connecting to {uri} with ping_interval=None + data-stream liveness")
    log("EXP-B", f"Liveness timeout: {LIVENESS_TIMEOUT}s | Run duration: {duration}s (0=∞)")

    reconnect_count = 0
    total_msgs      = 0
    run_start       = time.monotonic()

    while True:
        if duration > 0 and (time.monotonic() - run_start) >= duration:
            log("EXP-B", f"Run duration reached. msgs={total_msgs} reconnects={reconnect_count}")
            break
        if reconnect_count >= MAX_RECONNECTS:
            log("EXP-B", f"Max reconnects ({MAX_RECONNECTS}) reached — stopping.")
            break

        conn_start  = time.monotonic()
        msg_in_conn = 0

        try:
            async with websockets.connect(
                uri,
                ping_interval=None,   # ← critical: disable lib heartbeat
                ping_timeout=None,
                close_timeout=5,
            ) as ws:
                log("EXP-B", f"Connected (reconnect #{reconnect_count})")

                while True:
                    if duration > 0 and (time.monotonic() - run_start) >= duration:
                        break

                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=LIVENESS_TIMEOUT)
                    except asyncio.TimeoutError:
                        elapsed = round(time.monotonic() - conn_start, 2)
                        log("EXP-B", f"LIVENESS TIMEOUT after {elapsed}s silence — reconnecting")
                        break

                    msg_in_conn += 1
                    total_msgs  += 1

                    if msg_in_conn <= 3 or msg_in_conn % 100 == 0:
                        try:
                            data = json.loads(raw)
                            log("EXP-B", f"msg #{total_msgs}: update_id={data.get('update_id','?')} bids={len(data.get('bids',[]))} asks={len(data.get('asks',[]))}")
                        except Exception:
                            log("EXP-B", f"msg #{total_msgs}: {raw[:120]}")

        except websockets.exceptions.ConnectionClosedError as e:
            elapsed = round(time.monotonic() - conn_start, 2)
            log("EXP-B", f"CLOSED after {elapsed}s — code={e.code} reason={e.reason!r}")
            reconnect_count += 1
            backoff = min(2 ** reconnect_count, 30)
            log("EXP-B", f"Reconnecting in {backoff}s (attempt {reconnect_count}/{MAX_RECONNECTS})")
            await asyncio.sleep(backoff)

        except Exception as e:
            log("EXP-B", f"ERROR: {type(e).__name__}: {e}")
            reconnect_count += 1
            await asyncio.sleep(2)

    log("EXP-B", f"Finished. total_msgs={total_msgs} reconnects={reconnect_count}")


# ── main ──────────────────────────────────────────────────────────────────────
async def main():
    parser = argparse.ArgumentParser(description="01 Exchange WS probe")
    parser.add_argument("--exp",    choices=["a", "b"], default=None,
                        help="Run only experiment A or B (default: both)")
    parser.add_argument("--stream", default=STREAM,
                        help=f"WS stream path (default: {STREAM})")
    parser.add_argument("--host",   default=HOST,
                        help=f"WS host (default: {HOST})")
    parser.add_argument("--duration", type=float, default=EXP_B_DURATION,
                        help=f"EXP-B run duration in seconds, 0=∞ (default: {EXP_B_DURATION})")
    args = parser.parse_args()

    uri = f"{args.host}/ws/{args.stream}"

    print("=" * 64)
    print(f"  01 Exchange WS Probe")
    print(f"  URI    : {uri}")
    print(f"  Liveness timeout: {LIVENESS_TIMEOUT}s")
    print("=" * 64)

    run_a = args.exp in (None, "a")
    run_b = args.exp in (None, "b")

    if run_a:
        print()
        print("─" * 64)
        print("  EXP-A: Default settings (lib heartbeat ON)")
        print("─" * 64)
        await experiment_a(uri)

    if run_a and run_b:
        print()
        print("Pausing 3 s between experiments …")
        await asyncio.sleep(3)

    if run_b:
        print()
        print("─" * 64)
        print("  EXP-B: ping_interval=None + data-stream liveness (CORRECT)")
        print("─" * 64)
        await experiment_b(uri, duration=args.duration)

    print()
    print("=" * 64)
    print("  Probe complete.")
    print("=" * 64)


if __name__ == "__main__":
    asyncio.run(main())
