import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderBook } from "./book.js";

test("snapshot sets absolute levels and best prices", () => {
  const b = new OrderBook();
  b.setLevel("bid", 100, 5);
  b.setLevel("bid", 99, 3);
  b.setLevel("ask", 101, 4);
  b.setLevel("ask", 102, 2);
  assert.equal(b.bestBid, 100);
  assert.equal(b.bestAsk, 101);
  assert.equal(b.mid(), 100.5);
  assert.equal(b.crossed(), false);
});

test("signed delta adds, removes, and recomputes best on top removal", () => {
  const b = new OrderBook();
  b.setLevel("bid", 100, 5);
  b.setLevel("bid", 99, 3);
  b.applyDelta("bid", 100, 2); // 5 -> 7
  assert.equal(b.depthAt("bid", 100), 7);
  b.applyDelta("bid", 100, -7); // remove top
  assert.equal(b.depthAt("bid", 100), 0);
  assert.equal(b.bestBid, 99); // rescanned to next level
});

test("levels() returns best-first ordering per side", () => {
  const b = new OrderBook();
  b.setLevel("bid", 99, 1);
  b.setLevel("bid", 100, 1);
  b.setLevel("ask", 102, 1);
  b.setLevel("ask", 101, 1);
  assert.deepEqual(b.levels("bid").map((l) => l[0]), [100, 99]);
  assert.deepEqual(b.levels("ask").map((l) => l[0]), [101, 102]);
});

test("crossed() detects an inverted book", () => {
  const b = new OrderBook();
  b.setLevel("bid", 101, 1);
  b.setLevel("ask", 100, 1);
  assert.equal(b.crossed(), true);
});
