/**
 * Sim adapters — implement the core port interfaces over the MatchingEngine so
 * the same strategy code runs in backtest without touching the SDK.
 *
 * Architecture:
 *   SimState     — shared bookkeeping: positions, realized PnL, equity.
 *   SimOrderGateway implements IOrderGateway  — routes orders to per-market engines.
 *   SimPositions    implements IPositions      — reads positions from SimState.
 *   SimAccount      implements IAccount        — equity / margins from SimState.
 *   SimBalances     implements IBalances        — simple USDC-based balance view.
 *
 * The backtest driver (M3) creates one OrderBook + MatchingEngine per market,
 * feeds events through them, and calls simState.applyFills() for maker fills
 * from engine.onTrade(). Taker fills from place() are applied internally.
 */
import { Side } from "@n1xyz/nord-ts";
import { Decimal } from "../utils/decimal.js";
import type { IOrderGateway, IAccount, IPositions, IBalances } from "../core/ports.js";
import type { PlaceIntent, PlaceResult, NormalizedOrder } from "../core/orders.js";
import type { Position } from "../core/positions.js";
import type { TokenBalance } from "../core/balances.js";
import type { MatchingEngine } from "./matching.js";
import type { Fill, SimOrderIntent } from "./types.js";

// ── SimState ──────────────────────────────────────────────────────────────────

interface PosState {
  symbol: string;
  marketId: number;
  signedSize: number;
  entryPrice: number;
  realizedPnl: number;
  fees: number;
}

export class SimState {
  private positions = new Map<string, PosState>();
  private marks = new Map<string, number>();
  private totalRealizedPnl = 0;
  private totalFees = 0;

  constructor(readonly initialEquity: number) {}

  applyFills(fills: Fill[], symbol: string, marketId: number): void {
    for (const f of fills) this.applyFill(f, symbol, marketId);
  }

  setMark(symbol: string, price: number): void {
    this.marks.set(symbol, price);
  }

  equity(): number {
    return this.initialEquity + this.totalRealizedPnl - this.totalFees + this.unrealizedPnl();
  }

  unrealizedPnl(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      if (Math.abs(pos.signedSize) < 1e-12) continue;
      const mark = this.marks.get(pos.symbol) ?? pos.entryPrice;
      total += (mark - pos.entryPrice) * pos.signedSize;
    }
    return total;
  }

  positionList(): Position[] {
    const out: Position[] = [];
    for (const pos of this.positions.values()) {
      if (Math.abs(pos.signedSize) < 1e-12) continue;
      out.push(this.toPosition(pos));
    }
    return out;
  }

  positionGet(symbol: string): Position | null {
    const pos = this.positions.get(symbol);
    if (!pos || Math.abs(pos.signedSize) < 1e-12) return null;
    return this.toPosition(pos);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private applyFill(f: Fill, symbol: string, marketId: number): void {
    this.totalFees += f.fee;

    let pos = this.positions.get(symbol);
    if (!pos) {
      pos = { symbol, marketId, signedSize: 0, entryPrice: 0, realizedPnl: 0, fees: 0 };
      this.positions.set(symbol, pos);
    }
    pos.fees += f.fee;

    const delta = f.side === "bid" ? f.size : -f.size;
    const prev = pos.signedSize;
    const next = prev + delta;

    if (prev === 0) {
      pos.signedSize = next;
      pos.entryPrice = f.price;
    } else if (Math.sign(delta) === Math.sign(prev)) {
      const cost = pos.entryPrice * Math.abs(prev) + f.price * f.size;
      pos.signedSize = next;
      pos.entryPrice = cost / Math.abs(next);
    } else {
      const reduced = Math.min(f.size, Math.abs(prev));
      const pnl = (f.price - pos.entryPrice) * reduced * Math.sign(prev);
      pos.realizedPnl += pnl;
      this.totalRealizedPnl += pnl;

      if (Math.abs(next) < 1e-12) {
        pos.signedSize = 0;
        pos.entryPrice = 0;
      } else if (Math.sign(next) === Math.sign(prev)) {
        pos.signedSize = next;
      } else {
        pos.signedSize = next;
        pos.entryPrice = f.price;
      }
    }
  }

  private toPosition(pos: PosState): Position {
    const mark = this.marks.get(pos.symbol) ?? pos.entryPrice;
    const upnl = (mark - pos.entryPrice) * pos.signedSize;
    return {
      marketId: pos.marketId,
      symbol: pos.symbol,
      baseSize: new Decimal(Math.abs(pos.signedSize)),
      isLong: pos.signedSize > 0,
      entryPrice: new Decimal(pos.entryPrice),
      unrealizedPnl: new Decimal(upnl),
      fundingPnl: new Decimal(0),
      openOrders: 0,
    };
  }
}

// ── SimOrderGateway ───────────────────────────────────────────────────────────

interface SimMarket {
  symbol: string;
  marketId: number;
  engine: MatchingEngine;
}

export class SimOrderGateway implements IOrderGateway {
  private markets = new Map<string, SimMarket>();
  private cidCounter = 1;
  private fillHandler?: (fills: Fill[], symbol: string, marketId: number, ts: number) => void;

  constructor(
    private readonly state: SimState,
    private readonly clock: () => number,
  ) {}

  setFillHandler(handler: (fills: Fill[], symbol: string, marketId: number, ts: number) => void): void {
    this.fillHandler = handler;
  }

  addMarket(symbol: string, marketId: number, engine: MatchingEngine): void {
    this.markets.set(symbol, { symbol, marketId, engine });
  }

  async place(intent: PlaceIntent): Promise<PlaceResult> {
    const m = this.getMarket(intent.symbol);
    const cid = intent.clientOrderId ? Number(intent.clientOrderId) : this.cidCounter++;
    const simIntent: SimOrderIntent = {
      cid,
      side: intent.side as "bid" | "ask",
      type: intent.type,
      price: intent.price !== undefined ? Number(intent.price) : undefined,
      size: Number(intent.size ?? 0),
      reduceOnly: intent.reduceOnly,
    };
    const result = m.engine.submit(simIntent, this.clock());
    if (this.fillHandler) {
      this.fillHandler(result.fills, m.symbol, m.marketId, this.clock());
    } else {
      this.state.applyFills(result.fills, m.symbol, m.marketId);
    }
    const bigCid = BigInt(cid);
    return {
      actionId: bigCid,
      fills: result.fills.map((f) => ({ orderId: bigCid, price: f.price, size: f.size, accountId: 0 })),
      reducedOrders: [],
      selfTradeCancels: [],
      clientOrderId: bigCid,
    };
  }

  async cancel(orderId: bigint | number): Promise<unknown> {
    const id = Number(orderId);
    for (const m of this.markets.values()) {
      if (m.engine.cancel(id)) return { orderId: BigInt(id) };
    }
    return { orderId: BigInt(id) };
  }

  async cancelByClientId(clientOrderId: bigint | number): Promise<unknown> {
    return this.cancel(clientOrderId);
  }

  async edit(
    ref: bigint | number | { cid: bigint | number },
    changes: { price?: Decimal.Value; size?: Decimal.Value; symbol: string; side: any; type?: PlaceIntent["type"] },
  ): Promise<PlaceResult> {
    const cancelId = typeof ref === "object" && "cid" in ref ? ref.cid : ref;
    await this.cancel(cancelId);
    return this.place({
      symbol: changes.symbol,
      side: changes.side,
      type: changes.type ?? "limit",
      price: changes.price,
      size: changes.size,
    });
  }

  async cancelAll(symbol?: string): Promise<void> {
    const targets = symbol ? [this.getMarket(symbol)] : [...this.markets.values()];
    for (const m of targets) {
      for (const o of m.engine.open()) m.engine.cancel(o.cid);
    }
  }

  open(symbol?: string): NormalizedOrder[] {
    const out: NormalizedOrder[] = [];
    const targets = symbol ? [this.getMarket(symbol)] : [...this.markets.values()];
    for (const m of targets) {
      for (const o of m.engine.open()) {
        out.push({
          orderId: o.cid,
          marketId: m.marketId,
          symbol: m.symbol,
          side: o.side === "bid" ? Side.Bid : Side.Ask,
          size: new Decimal(o.remaining),
          price: new Decimal(o.price),
          originalOrderSize: new Decimal(o.remaining),
          clientOrderId: o.cid,
        });
      }
    }
    return out;
  }

  getById(orderId: number): NormalizedOrder | null {
    for (const m of this.markets.values()) {
      const o = m.engine.open().find((r) => r.cid === orderId);
      if (o) {
        return {
          orderId: o.cid,
          marketId: m.marketId,
          symbol: m.symbol,
          side: o.side === "bid" ? Side.Bid : Side.Ask,
          size: new Decimal(o.remaining),
          price: new Decimal(o.price),
          originalOrderSize: new Decimal(o.remaining),
          clientOrderId: o.cid,
        };
      }
    }
    return null;
  }

  private getMarket(symbol: string): SimMarket {
    const m = this.markets.get(symbol);
    if (!m) throw new Error(`No sim market configured: ${symbol}`);
    return m;
  }
}

// ── SimAccount ────────────────────────────────────────────────────────────────

export class SimAccount implements IAccount {
  readonly accountId = 0;

  constructor(private readonly state: SimState) {}

  async refresh(): Promise<void> {}

  ageMs(): number {
    return 0;
  }

  equity(): Decimal {
    return new Decimal(this.state.equity());
  }

  rawMargins() {
    const eq = this.state.equity();
    return { mf: eq, imf: 0, omf: eq, cmf: 0, mmf: 0, pon: 0, pn: 0, bankruptcy: eq <= 0 };
  }
}

// ── SimPositions ──────────────────────────────────────────────────────────────

export class SimPositions implements IPositions {
  constructor(
    private readonly state: SimState,
    private readonly gateway: SimOrderGateway,
  ) {}

  list(): Position[] {
    return this.state.positionList();
  }

  get(symbol: string): Position | null {
    return this.state.positionGet(symbol);
  }

  async close(symbol: string, fraction = 1): Promise<void> {
    const pos = this.get(symbol);
    if (!pos) return;
    const size = fraction < 1 ? pos.baseSize.mul(fraction) : pos.baseSize;
    if (size.isZero()) return;
    await this.gateway.place({
      symbol,
      side: pos.isLong ? Side.Ask : Side.Bid,
      type: "ioc",
      size,
      reduceOnly: true,
    });
  }
}

// ── SimBalances ───────────────────────────────────────────────────────────────

export class SimBalances implements IBalances {
  constructor(private readonly state: SimState) {}

  exchange(): TokenBalance[] {
    return [{ symbol: "USDC", balance: new Decimal(this.state.equity()), accountId: 0 }];
  }

  free(_token?: string): Decimal {
    return new Decimal(Math.max(0, this.state.equity()));
  }
}
