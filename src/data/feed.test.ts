import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Nord } from "@n1xyz/nord-ts";
import { LiveFeed } from "./feed.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal stand-in for the SDK WS client used by LiveFeed. */
class FakeWS extends EventEmitter {
  shouldReconnect = false;
  pingInterval: ReturnType<typeof setInterval> | null = null;
  pingTimeout: ReturnType<typeof setTimeout> | null = null;
  reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  closed = false;
  close() { this.closed = true; }
}

/**
 * Regression: a sustained outage (every connect attempt fails before reaching
 * "connected") must NOT latch the feed. Before the fix, `reconnecting` was only
 * cleared on a successful "connected", so the first failed reconnect left it
 * stuck true forever and scheduleReconnect() silently swallowed every later
 * attempt — the 2026-06-26 22h WS-death. The feed must keep re-creating the WS.
 */
test("feed keeps retrying after failed reconnect attempts (no latch)", async () => {
  let wsCount = 0;
  const nord = {
    createWebSocketClient() {
      wsCount++;
      const ws = new FakeWS();
      // Fail on the next tick, after LiveFeed.connect() attaches its handlers —
      // mimics a server 502 that never lets the socket reach "connected".
      setImmediate(() => {
        ws.emit("error", new Error("Unexpected server response: 502"));
        ws.emit("disconnected");
      });
      return ws as unknown as ReturnType<Nord["createWebSocketClient"]>;
    },
    async getOrderbook() { return { updateId: 0, bids: [], asks: [] }; },
  } as unknown as Nord;

  const feed = new LiveFeed(nord, {
    trades: ["ETHUSD"],
    deltas: ["ETHUSD"],
    baseReconnectDelayMs: 5,
    maxReconnectDelayMs: 10,
  });
  feed.on("error", () => {}); // swallow surfaced WS errors so EventEmitter doesn't throw

  feed.start();
  await sleep(200);
  feed.close();

  // Without the fix wsCount latches at 2 (initial connect + one reconnect, then
  // the guard never clears). With it, attempts keep firing under backoff.
  assert.ok(wsCount >= 3, `feed latched after ${wsCount} connect attempts`);
});
