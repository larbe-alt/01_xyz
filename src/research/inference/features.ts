/**
 * Feature computer — computes the same features as research/src/features.py
 * from a LocalBook + rolling trade/mid buffers.
 *
 * The parity test (research/tests/test_parity.py) verifies these produce
 * identical output to the Python side on the same input.
 */
import type { LocalBook } from "../../data/feed.js";

export interface TradeRecord {
  ts: number;
  side: string;
  price: number;
  size: number;
}

export interface FeatureVector {
  spread_bps: number;
  microprice: number;
  book_imbalance_1: number;
  book_imbalance_5: number;
  depth_bid_5: number;
  depth_ask_5: number;
  depth_ratio_5: number;
  wap_distance_bps: number;
  trade_imbalance_60s: number;
  trade_intensity_60s: number;
  avg_trade_size_60s: number;
  ofi_60s: number;
  realized_vol_300s: number;
  return_10s: number;
  return_60s: number;
}

export const FEATURE_NAMES: (keyof FeatureVector)[] = [
  "spread_bps", "microprice", "book_imbalance_1", "book_imbalance_5",
  "depth_bid_5", "depth_ask_5", "depth_ratio_5", "wap_distance_bps",
  "trade_imbalance_60s", "trade_intensity_60s", "avg_trade_size_60s",
  "ofi_60s", "realized_vol_300s", "return_10s", "return_60s",
];

// ── Book features ───────────────────────────────────────────────────────────

function topBids(book: LocalBook, n: number): [number, number][] {
  return [...book.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, n);
}

function topAsks(book: LocalBook, n: number): [number, number][] {
  return [...book.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, n);
}

function mid(book: LocalBook): number | null {
  if (book.bestBid === -Infinity || book.bestAsk === Infinity) return null;
  return (book.bestBid + book.bestAsk) / 2;
}

function spreadBps(book: LocalBook): number {
  const m = mid(book);
  if (m === null || m === 0) return 0;
  return (book.bestAsk - book.bestBid) / m * 10_000;
}

function micropriceCalc(book: LocalBook): number {
  const tb = topBids(book, 1);
  const ta = topAsks(book, 1);
  if (tb.length === 0 || ta.length === 0) return 0;
  const [bidP, bidS] = tb[0];
  const [askP, askS] = ta[0];
  const total = bidS + askS;
  if (total === 0) return 0;
  return (bidP * askS + askP * bidS) / total;
}

function bookImbalance(book: LocalBook, levels: number): number {
  const bids = topBids(book, levels);
  const asks = topAsks(book, levels);
  let bidQty = 0;
  let askQty = 0;
  for (const [, s] of bids) bidQty += s;
  for (const [, s] of asks) askQty += s;
  const total = bidQty + askQty;
  if (total === 0) return 0;
  return (bidQty - askQty) / total;
}

function depthBid(book: LocalBook, levels: number): number {
  let sum = 0;
  for (const [, s] of topBids(book, levels)) sum += s;
  return sum;
}

function depthAsk(book: LocalBook, levels: number): number {
  let sum = 0;
  for (const [, s] of topAsks(book, levels)) sum += s;
  return sum;
}

function depthRatio(book: LocalBook, levels: number): number {
  const da = depthAsk(book, levels);
  if (da === 0) return 0;
  return depthBid(book, levels) / da;
}

function wapDistanceBps(book: LocalBook, levels: number): number {
  const m = mid(book);
  if (m === null || m === 0) return 0;

  const bids = topBids(book, levels);
  const asks = topAsks(book, levels);

  let bidNotional = 0, bidQty = 0;
  for (const [p, s] of bids) { bidNotional += p * s; bidQty += s; }
  let askNotional = 0, askQty = 0;
  for (const [p, s] of asks) { askNotional += p * s; askQty += s; }

  if (bidQty === 0 || askQty === 0) return 0;
  const vwapBid = bidNotional / bidQty;
  const vwapAsk = askNotional / askQty;
  return (vwapAsk - vwapBid) / m * 10_000;
}

// ── Trade flow features ─────────────────────────────────────────────────────

function tradesInWindow(trades: TradeRecord[], now: number, windowMs: number): TradeRecord[] {
  const cutoff = now - windowMs;
  return trades.filter(t => t.ts >= cutoff);
}

function tradeImbalance(trades: TradeRecord[], now: number, windowMs: number): number {
  const w = tradesInWindow(trades, now, windowMs);
  if (w.length === 0) return 0;
  let buy = 0, sell = 0;
  for (const t of w) {
    if (t.side === "bid") buy += t.size;
    else sell += t.size;
  }
  const total = buy + sell;
  if (total === 0) return 0;
  return (buy - sell) / total;
}

function tradeIntensity(trades: TradeRecord[], now: number, windowMs: number): number {
  if (windowMs === 0) return 0;
  const w = tradesInWindow(trades, now, windowMs);
  return w.length / (windowMs / 1000);
}

function avgTradeSize(trades: TradeRecord[], now: number, windowMs: number): number {
  const w = tradesInWindow(trades, now, windowMs);
  if (w.length === 0) return 0;
  let sum = 0;
  for (const t of w) sum += t.size;
  return sum / w.length;
}

function ofiCalc(trades: TradeRecord[], now: number, windowMs: number): number {
  const w = tradesInWindow(trades, now, windowMs);
  if (w.length === 0) return 0;
  let signed = 0, total = 0;
  for (const t of w) {
    signed += t.side === "bid" ? t.size : -t.size;
    total += t.size;
  }
  if (total === 0) return 0;
  return signed / total;
}

// ── Volatility features ─────────────────────────────────────────────────────

interface MidEntry { ts: number; mid: number; }

function midsInWindow(mids: MidEntry[], now: number, windowMs: number): MidEntry[] {
  const cutoff = now - windowMs;
  return mids.filter(e => e.ts >= cutoff);
}

function midAtOrBefore(mids: MidEntry[], targetTs: number): number | null {
  let result: number | null = null;
  for (const e of mids) {
    if (e.ts <= targetTs) result = e.mid;
    else break;
  }
  return result;
}

function realizedVol(mids: MidEntry[], now: number, windowMs: number): number {
  const entries = midsInWindow(mids, now, windowMs);
  if (entries.length < 2) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].mid > 0 && entries[i].mid > 0) {
      logReturns.push(Math.log(entries[i].mid / entries[i - 1].mid));
    }
  }
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const dtAvg = (entries[entries.length - 1].ts - entries[0].ts) / Math.max(entries.length - 1, 1) / 1000;
  if (dtAvg <= 0) return 0;
  const periodsPerYear = 365.25 * 24 * 3600 / dtAvg;
  return Math.sqrt(variance * periodsPerYear);
}

function logReturn(mids: MidEntry[], now: number, windowMs: number): number {
  const current = midAtOrBefore(mids, now);
  const past = midAtOrBefore(mids, now - windowMs);
  if (current === null || past === null || past <= 0 || current <= 0) return 0;
  return Math.log(current / past);
}

// ── Rolling state manager ───────────────────────────────────────────────────

export class FeatureState {
  private trades: TradeRecord[] = [];
  private mids: MidEntry[] = [];
  private readonly maxWindowMs: number;

  constructor(maxWindowMs = 300_000) {
    this.maxWindowMs = maxWindowMs;
  }

  addTrade(t: TradeRecord): void {
    this.trades.push(t);
  }

  addMid(ts: number, midVal: number): void {
    this.mids.push({ ts, mid: midVal });
  }

  prune(now: number): void {
    const cutoff = now - this.maxWindowMs;
    while (this.trades.length > 0 && this.trades[0].ts < cutoff) this.trades.shift();
    while (this.mids.length > 0 && this.mids[0].ts < cutoff) this.mids.shift();
  }

  compute(book: LocalBook, now: number): FeatureVector {
    return {
      spread_bps: spreadBps(book),
      microprice: micropriceCalc(book),
      book_imbalance_1: bookImbalance(book, 1),
      book_imbalance_5: bookImbalance(book, 5),
      depth_bid_5: depthBid(book, 5),
      depth_ask_5: depthAsk(book, 5),
      depth_ratio_5: depthRatio(book, 5),
      wap_distance_bps: wapDistanceBps(book, 5),
      trade_imbalance_60s: tradeImbalance(this.trades, now, 60_000),
      trade_intensity_60s: tradeIntensity(this.trades, now, 60_000),
      avg_trade_size_60s: avgTradeSize(this.trades, now, 60_000),
      ofi_60s: ofiCalc(this.trades, now, 60_000),
      realized_vol_300s: realizedVol(this.mids, now, 300_000),
      return_10s: logReturn(this.mids, now, 10_000),
      return_60s: logReturn(this.mids, now, 60_000),
    };
  }

  toArray(fv: FeatureVector): number[] {
    return FEATURE_NAMES.map(k => fv[k]);
  }
}
