/**
 * Parity check helper — called by research/tests/test_parity.py.
 *
 * Reads a JSON test case from argv, computes features with the TS implementation,
 * prints the result as JSON to stdout.
 *
 * Usage: npx tsx src/research/inference/parity-check.ts '<json>'
 */
import { FeatureState } from "./features.js";
import type { LocalBook } from "../../data/feed.js";

const input = JSON.parse(process.argv[2]);

// Build LocalBook from test case
const bids = new Map<number, number>();
const asks = new Map<number, number>();
for (const [p, s] of input.book.bids) bids.set(p, s);
for (const [p, s] of input.book.asks) asks.set(p, s);

let bestBid = -Infinity;
for (const k of bids.keys()) if (k > bestBid) bestBid = k;
let bestAsk = Infinity;
for (const k of asks.keys()) if (k < bestAsk) bestAsk = k;

const book: LocalBook = {
  symbol: "TEST",
  updateId: 1,
  bids,
  asks,
  bestBid,
  bestAsk,
  synced: true,
  lastUpdateMs: input.now,
};

// Build feature state with trades + mids
const state = new FeatureState(300_000);
for (const t of input.trades) {
  state.addTrade({ ts: t.ts, side: t.side, price: t.price, size: t.size });
}
for (const m of input.mids) {
  state.addMid(m.ts, m.mid);
}

// Compute and print
const feats = state.compute(book, input.now);
console.log(JSON.stringify(feats));
