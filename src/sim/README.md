# `src/sim` — execution simulator

A small, SDK-free matching engine that fills orders against **recorded market
data** the same way the real venue would. It's the execution backend for
backtesting (see [`docs/backtest-plan.md`](../../docs/backtest-plan.md)).

You can use everything below from the public API alone — you do **not** need to
read the implementation.

---

## What it does

- **Taker orders** (`market`/`ioc`/`fok`/marketable `limit`) walk the recorded book
  best-first → VWAP fill. Slippage is not a knob; it comes from real depth.
- **Maker orders** (resting `limit`/`postOnly`) join the **back of the queue** at
  their price and only fill when recorded trades print through them.
- Models `postOnly` reject-on-cross, `reduceOnly` clamping, FOK kill, partial
  fills, FIFO at a price level, and maker/taker fees (rebates allowed).
- **No look-ahead** is structural: settle resting fills for an event *before* the
  strategy reacts to that event (see the loop below).

It does **not** track PnL/equity (that's the upcoming `src/backtest` module) and
does **not** mutate the recorded book when your orders take liquidity (orders are
assumed small vs. displayed depth).

---

## Public API

| Export | From | Purpose |
|---|---|---|
| `OrderBook` | `book.js` | reconstruct an L2 book from snapshots/deltas |
| `MatchingEngine` | `matching.js` | submit orders, settle fills against trades |
| `loadNative01Market()` | `sources/native01.js` | load **this repo's** 01 recorder data |
| `loadFuelo2Market()` | `sources/fuelo2.js` | load the older fuel_o2 B2 archive |
| `SimState` | `adapters.js` | shared position/PnL/equity bookkeeping |
| `SimOrderGateway` | `adapters.js` | `IOrderGateway` over matching engines |
| `SimAccount` | `adapters.js` | `IAccount` — equity/margins from SimState |
| `SimPositions` | `adapters.js` | `IPositions` — reads/closes positions |
| `SimBalances` | `adapters.js` | `IBalances` — USDC balance from equity |
| types: `SimOrderIntent`, `Fill`, `MarketTrade`, `FeeModel`, `Side`, … | `types.js` | |

### `OrderBook`
```ts
const book = new OrderBook();
book.setLevel("bid", 1767.0, 0.17);   // absolute size (snapshot/native delta; size 0 removes)
book.applyDelta("bid", 1767.0, -0.05); // signed increment (fuel_o2 delta)
book.bestBid; book.bestAsk; book.mid(); book.crossed();
book.depthAt("bid", 1767.0);          // size resting at a level
book.levels("ask");                    // [[price,size],…] best-first
```

### `MatchingEngine`
```ts
const eng = new MatchingEngine(book, { makerBps: -1, takerBps: 5 });

// place an order (cid is your client id; ts is the current event time)
const r = eng.submit({ cid: 1, side: "bid", type: "market", size: 0.5 }, ts);
//        → { fills: Fill[], rested: boolean, rejected?: string }

// settle resting orders against a recorded print (t.side = TAKER/aggressor side)
const fills = eng.onTrade({ side: "ask", price: 1767, size: 0.3, ts });

eng.cancel(1);     // remove a resting order
eng.open();        // RestingOrder[] still on the book
eng.position();    // net base position from our own fills (+long/-short)
```

`Fill = { cid, side, price, size, fee, liquidity: "maker"|"taker", ts }`
(`fee` is signed quote: positive = paid, negative = rebate.)

---

## The one rule that keeps it honest

Drive it with this event-loop ordering, or you'll leak look-ahead:

```ts
for (const ev of events) {
  if (ev.kind === "snapshot") { book.clear(); applyLevels(ev); }
  else if (ev.kind === "delta") { applyLevels(ev); }
  else /* trade */ {
    const fills = eng.onTrade(ev.trade);  // 1) settle resting fills FIRST
    record(fills);
    // 2) THEN let the strategy react and place new orders
  }
  strategy.onEvent(ev, eng);              // new orders can only fill on LATER prints
}
```

Because a resting order placed in reaction to a print is added *after* that
print was settled, it can never fill on the trade it reacted to.

---

## Loading recorded data

```ts
// This repo's own 01 recorder (canonical): data/<env>/<stream>/<SYMBOL>/*.parquet
const events = await loadNative01Market({ dir: "data", env: "mainnet", market: "ETHUSD" });
// → Native01Event[]  (kind: "snapshot" | "delta" | "trade", real units)

// Older fuel_o2 B2 archive: scaled-int (1e9), signed-delta depth
const { base, stream } = await loadFuelo2Market({ dir: "data/raw", date: "2026-05-23", market: "USDT-USDC" });
```

Pull data to the Mac first (never run on the recorder VPS — see the `vps-workflow`
skill). Example: `rsync -az tokyo:/root/01_xyz/data/mainnet/{snapshot,delta,trade}/ETHUSD data/mainnet/<stream>/`.

---

## Adapters — plugging a strategy into the sim

Port interfaces (`src/core/ports.ts`) decouple strategies from the SDK.
The sim adapters implement them over the matching engine:

```ts
import { OrderBook } from "./book.js";
import { MatchingEngine } from "./matching.js";
import { SimState, SimOrderGateway, SimAccount, SimPositions, SimBalances } from "./adapters.js";

const state = new SimState(10_000);                          // initial equity
const gw    = new SimOrderGateway(state, () => currentTs);   // clock fn
const book  = new OrderBook();
const eng   = new MatchingEngine(book, { makerBps: -1, takerBps: 5 });
gw.addMarket("ETHUSD", /*marketId*/ 1, eng);

const account   = new SimAccount(state);
const positions = new SimPositions(state, gw);
const balances  = new SimBalances(state);

// Wire into GuardedOrders + buildContext exactly like the live runner does,
// but passing these sim adapters instead of the SDK managers.
```

In the event loop the driver must apply maker fills and update the mark:

```ts
const fills = eng.onTrade(trade);
state.applyFills(fills, "ETHUSD", 1);  // bookkeep position + PnL
state.setMark("ETHUSD", trade.price);  // update mark for equity calc
```

---

## Verify / test

```bash
npm test                 # 34 unit tests — matching semantics + adapter position/equity tracking
npm run verify:sim:01    # replay real 01 data (ETHUSD/HYPEUSD), gate on 5 invariants
npm run verify:sim       # same, against the fuel_o2 archive
```

Correctness invariants the real-data runs enforce: book never crossed · mid in a
sane band · fills priced at/through the print · fill ≤ printed size · no look-ahead.

A complete worked example is `src/scripts/verify-sim-01.ts`.
