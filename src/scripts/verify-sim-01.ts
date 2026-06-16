/**
 * verify-sim-01 — same invariant gate as verify-sim, but against THIS repo's own
 * recorder data (the live 01 mainnet feed captured by recorder01 on the VPS).
 *
 *   npm run verify:sim:01 -- [--market ETHUSD] [--env mainnet] [--dir data]
 *
 * Book reconstruction here uses ABSOLUTE level sizes from snapshot/delta (native
 * schema), re-syncing on every snapshot. The matching engine and the five
 * correctness invariants are identical to the fuel_o2 path.
 */
import { loadNative01Market, type Native01Event } from "../sim/sources/native01.js";
import { OrderBook } from "../sim/book.js";
import { MatchingEngine } from "../sim/matching.js";
import type { FeeModel } from "../sim/types.js";

interface Args {
  market: string;
  env: string;
  dir: string;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { market: "ETHUSD", env: "mainnet", dir: "data" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--market") a.market = argv[++i];
    else if (argv[i] === "--env") a.env = argv[++i];
    else if (argv[i] === "--dir") a.dir = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const fees: FeeModel = { makerBps: -1, takerBps: 5 };

console.log(`Loading 01 ${args.env}/${args.market} from ${args.dir} …`);
const events = await loadNative01Market(args);

const book = new OrderBook();
const eng = new MatchingEngine(book, fees);

function applyLevels(ev: Extract<Native01Event, { bids: unknown }>): void {
  for (const [p, s] of ev.bids) book.setLevel("bid", p, s); // size 0 removes
  for (const [p, s] of ev.asks) book.setLevel("ask", p, s);
}

// ── invariants ──────────────────────────────────────────────────────────────────
let crossedViolations = 0;
let priceViolations = 0;
let queueViolations = 0;
let lookaheadViolations = 0;
let minMid = Infinity;
let maxMid = -Infinity;
let snapshots = 0;
let deltas = 0;
let trades = 0;
let ourFills = 0;
let ourFilledBase = 0;
let synced = false;

// ── passive, price-improving maker (same as verify-sim) ──────────────────────────
const MY_CID = 1;
let placedAt = -1;
let myPrice = -1;
let haveQuote = false;
const firstTradeSize = (events.find((e) => e.kind === "trade") as Extract<Native01Event, { trade: unknown }> | undefined)
  ?.trade.size ?? 1;
const QUOTE_BASE_SIZE = firstTradeSize * 3;

function reconcileQuote(nowTs: number): void {
  if (!synced) return;
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

function checkBook(): void {
  if (!synced) return;
  if (book.crossed()) crossedViolations++;
  const mid = book.mid();
  if (mid != null) {
    if (mid < minMid) minMid = mid;
    if (mid > maxMid) maxMid = mid;
  }
}

for (const ev of events) {
  if (ev.kind === "snapshot") {
    snapshots++;
    book.clear();
    applyLevels(ev);
    synced = true;
    checkBook();
  } else if (ev.kind === "delta") {
    deltas++;
    applyLevels(ev);
    checkBook();
  } else {
    trades++;
    const fills = eng.onTrade(ev.trade); // settle BEFORE requote → no look-ahead
    for (const f of fills) {
      ourFills++;
      ourFilledBase += f.size;
      if (f.side === "bid" && f.price < ev.trade.price - 1e-9) priceViolations++;
      if (f.size > ev.trade.size + 1e-9) queueViolations++;
      if (ev.trade.ts < placedAt) lookaheadViolations++;
    }
    if (haveQuote && !eng.open().some((o) => o.cid === MY_CID)) haveQuote = false;
  }
  reconcileQuote(ev.ts);
}

// ── report ────────────────────────────────────────────────────────────────────────
const bands: Record<string, [number, number]> = {
  ETHUSD: [500, 10000],
  HYPEUSD: [1, 200],
  BTCUSD: [10000, 300000],
};
const band = bands[args.market];
const sane = !band || (minMid >= band[0] && maxMid <= band[1]);

console.log("\n── replay ────────────────────────────────");
console.log(`snapshots         ${snapshots.toLocaleString()}`);
console.log(`deltas applied    ${deltas.toLocaleString()}`);
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
console.log(`${ourFills > 0 ? "ℹ" : "⚠"} maker fill path exercised: ${ourFills} fills`);
if (crossedViolations) console.log(`   crossed updates: ${crossedViolations}`);

console.log(`\n${failed === 0 ? "ALL INVARIANTS HELD ✓" : `${failed} INVARIANT(S) FAILED ✗`}`);
process.exit(failed === 0 ? 0 : 1);
