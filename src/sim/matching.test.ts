import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderBook } from "./book.js";
import { MatchingEngine } from "./matching.js";
import type { FeeModel } from "./types.js";

const NO_FEES: FeeModel = { makerBps: 0, takerBps: 0 };

/** Book: bids 100×2 / 99×3 ; asks 101×1 / 102×2 / 103×5 */
function makeBook(): OrderBook {
  const b = new OrderBook();
  b.setLevel("bid", 100, 2);
  b.setLevel("bid", 99, 3);
  b.setLevel("ask", 101, 1);
  b.setLevel("ask", 102, 2);
  b.setLevel("ask", 103, 5);
  return b;
}

test("taker market buy walks depth → VWAP across levels (slippage from real depth)", () => {
  const eng = new MatchingEngine(makeBook(), NO_FEES);
  const r = eng.submit({ cid: 1, side: "bid", type: "market", size: 4 }, 0);
  // 1@101 + 2@102 + 1@103
  assert.equal(r.fills.length, 3);
  assert.deepEqual(r.fills.map((f) => [f.price, f.size]), [[101, 1], [102, 2], [103, 1]]);
  const notional = r.fills.reduce((s, f) => s + f.price * f.size, 0);
  assert.equal(notional / 4, (101 + 204 + 103) / 4); // VWAP = 102.0
  assert.equal(eng.position(), 4);
});

test("FOK kills (no fills) when book can't fully fill", () => {
  const eng = new MatchingEngine(makeBook(), NO_FEES);
  const r = eng.submit({ cid: 1, side: "bid", type: "fok", size: 100 }, 0);
  assert.equal(r.fills.length, 0);
  assert.match(r.rejected ?? "", /FOK/);
  assert.equal(eng.position(), 0);
});

test("IOC fills what's available and discards the remainder (no rest)", () => {
  const eng = new MatchingEngine(makeBook(), NO_FEES);
  const r = eng.submit({ cid: 1, side: "bid", type: "ioc", price: 102, size: 10 }, 0);
  // capped at 102: 1@101 + 2@102 = 3 filled, rest discarded
  assert.equal(r.fills.reduce((s, f) => s + f.size, 0), 3);
  assert.equal(r.rested, false);
  assert.equal(eng.open().length, 0);
});

test("postOnly that would cross is rejected", () => {
  const eng = new MatchingEngine(makeBook(), NO_FEES);
  const r = eng.submit({ cid: 1, side: "bid", type: "postOnly", price: 101, size: 1 }, 0);
  assert.match(r.rejected ?? "", /postOnly/);
  assert.equal(eng.open().length, 0);
});

test("marketable limit takes the crossing part and rests the remainder", () => {
  const eng = new MatchingEngine(makeBook(), NO_FEES);
  // buy limit @101 for 3: only 1@101 is marketable, 2 rests at 101
  const r = eng.submit({ cid: 1, side: "bid", type: "limit", price: 101, size: 3 }, 0);
  assert.equal(r.fills.reduce((s, f) => s + f.size, 0), 1);
  assert.equal(r.rested, true);
  assert.equal(eng.open()[0].remaining, 2);
});

test("maker rests at BACK of queue; fills only after trade-through burns the queue ahead", () => {
  const b = new OrderBook();
  b.setLevel("bid", 100, 10); // 10 resting ahead of us at 100
  const eng = new MatchingEngine(b, NO_FEES);
  eng.submit({ cid: 1, side: "bid", type: "postOnly", price: 100, size: 5 }, 0);
  assert.equal(eng.open()[0].queueAhead, 10);

  // a sell print of 6 @100: burns 6 of the 10 ahead, we don't fill yet
  let fills = eng.onTrade({ side: "ask", price: 100, size: 6, ts: 1 });
  assert.equal(fills.length, 0);
  assert.equal(eng.open()[0].queueAhead, 4);

  // a sell print of 7 @100: burns remaining 4 ahead, then fills 3 of our 5
  fills = eng.onTrade({ side: "ask", price: 100, size: 7, ts: 2 });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].size, 3);
  assert.equal(fills[0].liquidity, "maker");
  assert.equal(eng.open()[0].remaining, 2);
});

test("trade not reaching our price does not fill us", () => {
  const b = new OrderBook();
  b.setLevel("bid", 100, 0); // empty level (no queue ahead)
  const eng = new MatchingEngine(b, NO_FEES);
  eng.submit({ cid: 1, side: "bid", type: "postOnly", price: 100, size: 5 }, 0);
  // sell print at 101 (above our bid) — doesn't reach 100
  const fills = eng.onTrade({ side: "ask", price: 101, size: 10, ts: 1 });
  assert.equal(fills.length, 0);
});

test("no look-ahead: an order placed AFTER a print cannot fill on that same print", () => {
  // Models the run-loop contract: onTrade() settles BEFORE the strategy submits.
  const b = new OrderBook();
  b.setLevel("bid", 100, 0);
  const eng = new MatchingEngine(b, NO_FEES);
  const printFills = eng.onTrade({ side: "ask", price: 100, size: 50, ts: 1 }); // settle first
  assert.equal(printFills.length, 0);
  eng.submit({ cid: 1, side: "bid", type: "postOnly", price: 100, size: 5 }, 1); // strategy reacts after
  assert.equal(eng.open()[0].remaining, 5); // untouched by the already-processed print
});

test("reduceOnly is clamped to the closable position and never flips it", () => {
  const eng = new MatchingEngine(makeBook(), NO_FEES);
  eng.submit({ cid: 1, side: "bid", type: "market", size: 3 }, 0); // long 3
  assert.equal(eng.position(), 3);
  // reduceOnly sell for 10 → clamped to 3
  const r = eng.submit({ cid: 2, side: "ask", type: "market", size: 10, reduceOnly: true }, 1);
  assert.equal(r.fills.reduce((s, f) => s + f.size, 0), 3);
  assert.equal(eng.position(), 0);
  // reduceOnly sell with no position → rejected no-op
  const r2 = eng.submit({ cid: 3, side: "ask", type: "market", size: 1, reduceOnly: true }, 2);
  assert.match(r2.rejected ?? "", /reduceOnly/);
});

test("fees: taker pays takerBps, maker earns a rebate when makerBps < 0", () => {
  const eng = new MatchingEngine(makeBook(), { makerBps: -1, takerBps: 5 });
  const taker = eng.submit({ cid: 1, side: "bid", type: "market", size: 1 }, 0);
  // 1@101 → fee = 101 * 1 * 5/1e4
  assert.ok(Math.abs(taker.fills[0].fee - (101 * 5) / 10_000) < 1e-12);

  const b = new OrderBook();
  b.setLevel("bid", 100, 0);
  const eng2 = new MatchingEngine(b, { makerBps: -1, takerBps: 5 });
  eng2.submit({ cid: 1, side: "bid", type: "postOnly", price: 100, size: 2 }, 0);
  const mk = eng2.onTrade({ side: "ask", price: 100, size: 2, ts: 1 });
  assert.ok(mk[0].fee < 0); // rebate
});

test("equal-price resting orders fill FIFO by arrival", () => {
  const b = new OrderBook();
  b.setLevel("bid", 100, 0);
  const eng = new MatchingEngine(b, NO_FEES);
  eng.submit({ cid: 1, side: "bid", type: "postOnly", price: 100, size: 2 }, 0);
  eng.submit({ cid: 2, side: "bid", type: "postOnly", price: 100, size: 2 }, 0);
  const fills = eng.onTrade({ side: "ask", price: 100, size: 3, ts: 1 });
  // cid 1 fills fully (2), cid 2 fills the remaining 1
  assert.equal(fills[0].cid, 1);
  assert.equal(fills[0].size, 2);
  assert.equal(fills[1].cid, 2);
  assert.equal(fills[1].size, 1);
});
