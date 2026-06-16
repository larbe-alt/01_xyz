import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Side } from "@n1xyz/nord-ts";
import { OrderBook } from "./book.js";
import { MatchingEngine } from "./matching.js";
import { SimState, SimOrderGateway, SimAccount, SimPositions, SimBalances } from "./adapters.js";
import type { Fill } from "./types.js";

// ── SimState: position tracking + equity ─────────────────────────────────────

describe("SimState", () => {
  it("opens a long, tracks entry + equity", () => {
    const s = new SimState(10_000);
    const fills: Fill[] = [{ cid: 1, side: "bid", price: 100, size: 2, fee: 1, liquidity: "taker", ts: 1 }];
    s.applyFills(fills, "ETHUSD", 1);

    const pos = s.positionGet("ETHUSD")!;
    assert.ok(pos);
    assert.equal(pos.isLong, true);
    assert.equal(Number(pos.baseSize), 2);
    assert.equal(Number(pos.entryPrice), 100);

    // equity = 10000 - 1 fee, no unrealized yet (mark defaults to entry)
    assert.equal(s.equity(), 9999);
  });

  it("averages entry on same-direction fills", () => {
    const s = new SimState(10_000);
    s.applyFills([{ cid: 1, side: "bid", price: 100, size: 1, fee: 0, liquidity: "taker", ts: 1 }], "ETH", 1);
    s.applyFills([{ cid: 2, side: "bid", price: 110, size: 1, fee: 0, liquidity: "taker", ts: 2 }], "ETH", 1);

    const pos = s.positionGet("ETH")!;
    assert.equal(Number(pos.baseSize), 2);
    assert.equal(Number(pos.entryPrice), 105); // (100+110)/2
  });

  it("realizes PnL on reducing fill", () => {
    const s = new SimState(10_000);
    s.applyFills([{ cid: 1, side: "bid", price: 100, size: 2, fee: 0, liquidity: "taker", ts: 1 }], "ETH", 1);
    s.applyFills([{ cid: 2, side: "ask", price: 120, size: 1, fee: 0, liquidity: "taker", ts: 2 }], "ETH", 1);

    const pos = s.positionGet("ETH")!;
    assert.equal(Number(pos.baseSize), 1);
    assert.equal(Number(pos.entryPrice), 100); // entry unchanged on partial reduce

    // realized PnL = (120-100)*1 = 20
    assert.equal(s.equity(), 10_020);
  });

  it("realizes PnL on full close", () => {
    const s = new SimState(10_000);
    s.applyFills([{ cid: 1, side: "bid", price: 100, size: 2, fee: 0, liquidity: "taker", ts: 1 }], "ETH", 1);
    s.applyFills([{ cid: 2, side: "ask", price: 120, size: 2, fee: 5, liquidity: "taker", ts: 2 }], "ETH", 1);

    assert.equal(s.positionGet("ETH"), null); // fully closed
    // realized = (120-100)*2 = 40, fees = 5
    assert.equal(s.equity(), 10_035);
  });

  it("flips direction correctly", () => {
    const s = new SimState(10_000);
    s.applyFills([{ cid: 1, side: "bid", price: 100, size: 2, fee: 0, liquidity: "taker", ts: 1 }], "ETH", 1);
    // sell 5 → close 2 long + open 3 short
    s.applyFills([{ cid: 2, side: "ask", price: 120, size: 5, fee: 0, liquidity: "taker", ts: 2 }], "ETH", 1);

    const pos = s.positionGet("ETH")!;
    assert.equal(pos.isLong, false);
    assert.equal(Number(pos.baseSize), 3);
    assert.equal(Number(pos.entryPrice), 120); // new entry at flip price

    // realized from closing the 2 long = (120-100)*2 = 40
    // unrealized: mark defaults to entry (120), so 0
    assert.equal(s.equity(), 10_040);
  });

  it("tracks unrealized PnL from mark", () => {
    const s = new SimState(10_000);
    s.applyFills([{ cid: 1, side: "bid", price: 100, size: 2, fee: 0, liquidity: "taker", ts: 1 }], "ETH", 1);
    s.setMark("ETH", 110);

    // unrealized = (110-100)*2 = 20
    assert.equal(s.equity(), 10_020);
    assert.equal(s.unrealizedPnl(), 20);
  });

  it("positionList skips flat positions", () => {
    const s = new SimState(10_000);
    s.applyFills([{ cid: 1, side: "bid", price: 100, size: 1, fee: 0, liquidity: "taker", ts: 1 }], "ETH", 1);
    s.applyFills([{ cid: 2, side: "ask", price: 100, size: 1, fee: 0, liquidity: "taker", ts: 2 }], "ETH", 1);

    assert.equal(s.positionList().length, 0);
  });
});

// ── SimOrderGateway ──────────────────────────────────────────────────────────

describe("SimOrderGateway", () => {
  function setup() {
    const state = new SimState(10_000);
    let now = 1;
    const gw = new SimOrderGateway(state, () => now);
    const book = new OrderBook();
    const engine = new MatchingEngine(book, { makerBps: -1, takerBps: 5 });
    gw.addMarket("ETHUSD", 1, engine);

    // populate some asks so taker buys can fill
    book.setLevel("ask", 100, 10);
    book.setLevel("ask", 101, 5);
    book.setLevel("bid", 99, 10);

    return { state, gw, book, engine, setNow: (t: number) => { now = t; } };
  }

  it("taker buy fills and updates position", async () => {
    const { state, gw } = setup();
    const r = await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "market", size: 3 });

    assert.ok(r.fills.length > 0);
    assert.equal(Number(r.clientOrderId), 1);

    const pos = state.positionGet("ETHUSD")!;
    assert.ok(pos);
    assert.equal(Number(pos.baseSize), 3);
    assert.equal(pos.isLong, true);
  });

  it("postOnly limit rests and shows in open()", async () => {
    const { gw } = setup();
    const r = await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "postOnly", price: 98, size: 1 });
    assert.equal(r.fills.length, 0);

    const open = gw.open("ETHUSD");
    assert.equal(open.length, 1);
    assert.equal(open[0].symbol, "ETHUSD");
    assert.equal(Number(open[0].price), 98);
    assert.equal(open[0].side, Side.Bid);
  });

  it("cancel removes resting order", async () => {
    const { gw } = setup();
    await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "postOnly", price: 98, size: 1, clientOrderId: BigInt(42) });
    assert.equal(gw.open().length, 1);

    await gw.cancel(42);
    assert.equal(gw.open().length, 0);
  });

  it("cancelAll clears all resting orders", async () => {
    const { gw } = setup();
    await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "postOnly", price: 97, size: 1 });
    await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "postOnly", price: 96, size: 1 });
    assert.equal(gw.open().length, 2);

    await gw.cancelAll();
    assert.equal(gw.open().length, 0);
  });

  it("getById finds resting order", async () => {
    const { gw } = setup();
    await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "postOnly", price: 98, size: 1, clientOrderId: BigInt(7) });

    const o = gw.getById(7);
    assert.ok(o);
    assert.equal(o!.symbol, "ETHUSD");
    assert.equal(Number(o!.price), 98);
  });

  it("edit cancel+replaces", async () => {
    const { gw } = setup();
    await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "postOnly", price: 98, size: 1, clientOrderId: BigInt(10) });
    assert.equal(gw.open().length, 1);

    await gw.edit(BigInt(10), { symbol: "ETHUSD", side: Side.Bid, type: "postOnly", price: 97, size: 2 });
    const open = gw.open();
    assert.equal(open.length, 1);
    assert.equal(Number(open[0].price), 97);
    assert.equal(Number(open[0].size), 2);
  });
});

// ── SimAccount ───────────────────────────────────────────────────────────────

describe("SimAccount", () => {
  it("reflects equity from SimState", () => {
    const state = new SimState(10_000);
    const acc = new SimAccount(state);
    assert.equal(Number(acc.equity()), 10_000);

    state.applyFills([{ cid: 1, side: "bid", price: 100, size: 1, fee: 5, liquidity: "taker", ts: 1 }], "ETH", 1);
    assert.equal(Number(acc.equity()), 9_995); // 10000 - 5 fee
  });

  it("rawMargins returns correct equity fields", () => {
    const state = new SimState(5_000);
    const acc = new SimAccount(state);
    const m = acc.rawMargins();
    assert.equal(m.mf, 5_000);
    assert.equal(m.bankruptcy, false);
  });

  it("ageMs returns 0 (always fresh)", () => {
    const acc = new SimAccount(new SimState(1000));
    assert.equal(acc.ageMs(), 0);
  });
});

// ── SimPositions ─────────────────────────────────────────────────────────────

describe("SimPositions", () => {
  it("close submits reduce-only IOC through the gateway", async () => {
    const state = new SimState(100_000);
    let now = 1;
    const gw = new SimOrderGateway(state, () => now);
    const book = new OrderBook();
    const engine = new MatchingEngine(book, { makerBps: 0, takerBps: 0 });
    gw.addMarket("ETHUSD", 1, engine);
    book.setLevel("ask", 100, 100);
    book.setLevel("bid", 99, 100);

    const pos = new SimPositions(state, gw);

    // open a long
    await gw.place({ symbol: "ETHUSD", side: Side.Bid, type: "market", size: 5 });
    assert.equal(pos.list().length, 1);

    // close it — should sell 5 at bid
    await pos.close("ETHUSD");
    assert.equal(pos.list().length, 0);
  });
});

// ── SimBalances ──────────────────────────────────────────────────────────────

describe("SimBalances", () => {
  it("reports USDC balance from equity", () => {
    const state = new SimState(10_000);
    const bal = new SimBalances(state);
    const ex = bal.exchange();
    assert.equal(ex.length, 1);
    assert.equal(ex[0].symbol, "USDC");
    assert.equal(Number(ex[0].balance), 10_000);
  });

  it("free returns max(0, equity)", () => {
    const state = new SimState(0);
    const bal = new SimBalances(state);
    assert.equal(Number(bal.free("USDC")), 0);
  });
});
