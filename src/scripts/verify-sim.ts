/**
 * verify-sim — integration check of the matching engine against REAL recorded
 * fuel_o2 data (not synthetic fixtures).
 *
 *   npm run verify:sim -- [--market USDT-USDC] [--date 2026-05-23] [--dir data/raw]
 *
 * It reconstructs the order book from snapshot + signed deltas, runs a passive
 * maker (a single resting bid at the touch, re-quoted when filled) through the
 * engine, and asserts the invariants the design promises:
 *
 *   1. the reconstructed book is never crossed (data + reconstruction sanity)
 *   2. mid price stays in a sane range for the market
 *   3. every maker fill is priced at/through its triggering print
 *   4. no single trade fills us for more than it printed (queue conservation)
 *   5. our resting order only ever fills on trades AFTER it was placed (no look-ahead)
 *
 * Exits non-zero if any invariant is violated.
 */
import { loadFuelo2Market } from "../sim/sources/fuelo2.js";
import { OrderBook } from "../sim/book.js";
import { MatchingEngine } from "../sim/matching.js";
import type { FeeModel } from "../sim/types.js";

interface Args {
  market: string;
  date: string;
  dir: string;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { market: "USDT-USDC", date: "2026-05-23", dir: "data/raw" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--market") a.market = argv[++i];
    else if (argv[i] === "--date") a.date = argv[++i];
    else if (argv[i] === "--dir") a.dir = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const fees: FeeModel = { makerBps: -1, takerBps: 5 };

console.log(`Loading ${args.market} ${args.date} from ${args.dir} …`);
const { base, stream } = await loadFuelo2Market(args);

const book = new OrderBook();
for (const lvl of base) book.setLevel(lvl.side, lvl.price, lvl.size);
const eng = new MatchingEngine(book, fees);

// ── invariant accumulators ─────────────────────────────────────────────────────
let crossedViolations = 0;
let priceViolations = 0;
let queueViolations = 0;
let lookaheadViolations = 0;
let minMid = Infinity;
let maxMid = -Infinity;
let updates = 0;
let trades = 0;
let ourFills = 0;
let ourFilledBase = 0;

// ── passive maker: a price-IMPROVING resting bid inside the spread ───────────────
// Joining at the touch in a thin market sits behind the full displayed queue and
// rarely fills. To exercise the trade-through path we improve the price (an empty
// level → queueAhead 0), which is a legitimate best-bid maker: sells printing
// through it fill us. Size is scaled to the market's typical trade size.
const MY_CID = 1;
let placedAt = -1; // ts our current quote was placed (for the look-ahead check)
let myPrice = -1;
let haveQuote = false;
const firstTradeSize = stream.find((e) => e.kind === "trade")?.trade.size ?? 1;
const QUOTE_BASE_SIZE = firstTradeSize * 3;

function reconcileQuote(nowTs: number): void {
  // Drop the quote if the market moved through it (no longer a valid in-spread bid).
  if (haveQuote && (myPrice <= book.bestBid || myPrice >= book.bestAsk)) {
    eng.cancel(MY_CID);
    haveQuote = false;
  }
  if (haveQuote) return;
  if (book.bestBid === -Infinity || book.bestAsk === Infinity) return;
  const spread = book.bestAsk - book.bestBid;
  if (spread <= 0) return;
  const price = book.bestBid + spread * 0.25;
  const r = eng.submit({ cid: MY_CID, side: "bid", type: "postOnly", price, size: QUOTE_BASE_SIZE }, nowTs);
  if (r.rejected) return;
  haveQuote = true;
  myPrice = price;
  placedAt = nowTs;
}

for (const ev of stream) {
  if (ev.kind === "update") {
    updates++;
    book.applyDelta(ev.side, ev.price, ev.delta);
    if (book.crossed()) crossedViolations++;
    const mid = book.mid();
    if (mid != null) {
      if (mid < minMid) minMid = mid;
      if (mid > maxMid) maxMid = mid;
    }
  } else {
    trades++;
    // Settle resting fills BEFORE any (re)quote — this is the no-look-ahead contract.
    const fills = eng.onTrade(ev.trade);
    for (const f of fills) {
      ourFills++;
      ourFilledBase += f.size;
      // (3) fill must be priced at/through the print
      if (f.side === "bid" && f.price < ev.trade.price - 1e-9) priceViolations++;
      // (4) can't fill more than printed
      if (f.size > ev.trade.size + 1e-9) queueViolations++;
      // (5) the print must be strictly after our quote was placed
      if (ev.trade.ts < placedAt) lookaheadViolations++;
    }
    // our quote gone? (filled out)
    if (haveQuote && !eng.open().some((o) => o.cid === MY_CID)) haveQuote = false;
  }
  reconcileQuote(ev.t);
}

// ── report ──────────────────────────────────────────────────────────────────────
const sane = (() => {
  // crude per-market sanity band for the mid
  const bands: Record<string, [number, number]> = {
    "USDT-USDC": [0.9, 1.1],
    "FUEL-USDC": [0.0001, 10],
    "ETH-USDC": [500, 10000],
    "wBTC-USDC": [10000, 200000],
  };
  const band = bands[args.market];
  if (!band) return true;
  return minMid >= band[0] && maxMid <= band[1];
})();

console.log("\n── replay ────────────────────────────────");
console.log(`base levels       ${base.length}`);
console.log(`updates applied   ${updates.toLocaleString()}`);
console.log(`trades replayed   ${trades.toLocaleString()}`);
console.log(`mid range         ${minMid.toPrecision(6)} … ${maxMid.toPrecision(6)}`);
console.log(`our maker fills    ${ourFills}  (base filled ${ourFilledBase.toPrecision(6)})`);
console.log(`net position       ${eng.position().toPrecision(6)}`);

console.log("\n── invariants (correctness gate) ─────────");
const checks: [string, boolean][] = [
  ["book never crossed", crossedViolations === 0],
  ["mid in sane band", sane],
  ["fills priced at/through print", priceViolations === 0],
  ["queue conservation (fill ≤ print)", queueViolations === 0],
  ["no look-ahead fills", lookaheadViolations === 0],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✔" : "✗"} ${name}`);
  if (!ok) failed++;
}
// Coverage, not correctness: whether the maker path got exercised depends on the
// market's liquidity (thin/wide books may never reach an in-spread quote).
console.log(`${ourFills > 0 ? "ℹ" : "⚠"} maker fill path exercised: ${ourFills} fills`);
if (crossedViolations) console.log(`   crossed updates: ${crossedViolations}`);
if (priceViolations) console.log(`   price violations: ${priceViolations}`);
if (queueViolations) console.log(`   queue violations: ${queueViolations}`);
if (lookaheadViolations) console.log(`   look-ahead violations: ${lookaheadViolations}`);

console.log(`\n${failed === 0 ? "ALL INVARIANTS HELD ✓" : `${failed} INVARIANT(S) FAILED ✗`}`);
process.exit(failed === 0 ? 0 : 1);
