/**
 * TraderRegistry — per-account aggregation over identified fills.
 *
 * Each trade is two fills: the taker (takerId, takerSide) and the maker
 * (makerId, opposite side). We feed both into avg-cost position accounting to
 * derive realized PnL, then mark the open position at the last seen price for
 * unrealized PnL. Volume / maker-taker / fees accumulate alongside.
 *
 * Account identity is global but positions are per-market (you can't net ETH
 * against HYPE), so position/PnL state is kept per market inside each account's
 * stats while volume and PnL totals aggregate at the account level.
 *
 * Honesty: we assume each account starts flat at the first fill we see. Realized
 * PnL and unrealized are exact only if that holds. `coverage` flags accounts
 * that never returned to flat in the window — their PnL leans on that assumption
 * and should be read as approximate.
 */
import type { TradeFromApi } from "@n1xyz/nord-ts";

interface MarketPos {
  pos: number; // signed base units
  avgEntry: number; // avg cost of the open position
  lastPrice: number; // last fill price seen — mark proxy
  everFlat: boolean; // position returned to exactly 0 at least once
}

export interface TraderStats {
  accountId: number;
  takerBase: number;
  makerBase: number;
  takerNotional: number; // quote = price * base
  makerNotional: number;
  takerCount: number;
  makerCount: number;
  feesPaid: number; // taker_fee + maker_fee; maker_fee may be a rebate (negative)
  realizedPnl: number; // net of fees
  wins: number; // closing fills with positive gross PnL
  losses: number; // closing fills with negative gross PnL
  perMarket: Map<number, MarketPos>;
}

function freshStats(accountId: number): TraderStats {
  return {
    accountId,
    takerBase: 0, makerBase: 0,
    takerNotional: 0, makerNotional: 0,
    takerCount: 0, makerCount: 0,
    feesPaid: 0, realizedPnl: 0, wins: 0, losses: 0,
    perMarket: new Map(),
  };
}

export class TraderRegistry {
  private readonly accounts = new Map<number, TraderStats>();

  /**
   * Feed one identified trade (produces a taker fill and a maker fill).
   * Trades MUST arrive in chronological (ascending tradeId) order — avg-cost
   * accounting is order-dependent. getTrades pages newest-first, so callers
   * must sort before replaying (see analyze.ts).
   */
  applyTrade(t: TradeFromApi): void {
    const buy = t.takerSide === "bid"; // taker bought
    const takerSize = buy ? t.baseSize : -t.baseSize;
    this.applyFill(t.takerId, t.marketId, takerSize, t.price, t.takerFee ?? 0, true);
    this.applyFill(t.makerId, t.marketId, -takerSize, t.price, t.makerFee ?? 0, false);
  }

  private applyFill(
    accountId: number,
    marketId: number,
    signed: number, // signed base: + buy, - sell
    price: number,
    fee: number,
    isTaker: boolean,
  ): void {
    let s = this.accounts.get(accountId);
    if (!s) { s = freshStats(accountId); this.accounts.set(accountId, s); }

    const base = Math.abs(signed);
    const notional = base * price;
    if (isTaker) { s.takerBase += base; s.takerNotional += notional; s.takerCount++; }
    else { s.makerBase += base; s.makerNotional += notional; s.makerCount++; }
    s.feesPaid += fee;
    s.realizedPnl -= fee; // fees are a cost

    let mp = s.perMarket.get(marketId);
    if (!mp) { mp = { pos: 0, avgEntry: 0, lastPrice: price, everFlat: false }; s.perMarket.set(marketId, mp); }
    mp.lastPrice = price;

    if (mp.pos === 0 || Math.sign(mp.pos) === Math.sign(signed)) {
      // opening or adding to the position → re-average entry
      const total = Math.abs(mp.pos) + base;
      mp.avgEntry = (mp.avgEntry * Math.abs(mp.pos) + price * base) / total;
      mp.pos += signed;
    } else {
      // reducing / closing / flipping → realize against avg entry
      const closeQty = Math.min(Math.abs(mp.pos), base);
      const gross = closeQty * (price - mp.avgEntry) * Math.sign(mp.pos);
      s.realizedPnl += gross;
      if (gross > 0) s.wins++; else if (gross < 0) s.losses++;
      mp.pos += signed;
      if (mp.pos === 0) {
        // rested at flat → basis is clean, fully attributable from here
        mp.avgEntry = 0;
        mp.everFlat = true;
      } else if (Math.sign(mp.pos) !== Math.sign(mp.pos - signed)) {
        // flipped through zero → remaining opens a new lot at fill price. Not a
        // true flat: the close it booked still leans on the start basis, so
        // don't set everFlat here.
        mp.avgEntry = price;
      }
    }
  }

  /** Unrealized PnL across the account's open positions (mark = last price). */
  unrealized(s: TraderStats): number {
    let u = 0;
    for (const mp of s.perMarket.values()) u += mp.pos * (mp.lastPrice - mp.avgEntry);
    return u;
  }

  /** "complete" = every open market touched flat at least once; else "partial". */
  coverage(s: TraderStats): "complete" | "partial" {
    for (const mp of s.perMarket.values()) {
      if (mp.pos !== 0 && !mp.everFlat) return "partial";
    }
    return "complete";
  }

  totalPnl(s: TraderStats): number {
    return s.realizedPnl + this.unrealized(s);
  }

  /** Fraction of closing fills that were profitable (0 if no closes yet). */
  winRate(s: TraderStats): number {
    const closes = s.wins + s.losses;
    return closes === 0 ? 0 : s.wins / closes;
  }

  /** Share of volume done as maker (0 = pure taker, 1 = pure maker). */
  makerShare(s: TraderStats): number {
    const v = s.takerBase + s.makerBase;
    return v === 0 ? 0 : s.makerBase / v;
  }

  totalNotional(s: TraderStats): number {
    return s.takerNotional + s.makerNotional;
  }

  all(): TraderStats[] {
    return [...this.accounts.values()];
  }
}
