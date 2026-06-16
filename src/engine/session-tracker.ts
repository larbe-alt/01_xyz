import type { StrategyContext } from "./types.js";
import type { PlaceResult } from "../core/orders.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface QuoteResult {
  side: "bid" | "ask";
  result: PlaceResult;
}

export interface FillRecord {
  ts: number;
  symbol: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  slippageBps: number;
  fairAtFill: number;
  positionAfter: number;
}

export interface EquitySnapshot {
  ts: number;
  equity: number;
  unrealizedPnl: number;
  position: number;
}

export interface SessionSummary {
  durationMs: number;
  startEquity: number;
  endEquity: number;
  totalReturn: number;

  // trades
  totalQuotes: number;
  totalFills: number;
  fillRate: number;
  totalVolume: number;

  // pnl
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;

  // quality
  winRate: number;
  profitFactor: number;
  avgWinUsd: number;
  avgLossUsd: number;
  avgSlippageBps: number;

  // risk
  maxPosition: number;
  maxDrawdown: number;
  maxDrawdownDurationMs: number;
  sharpe: number;
  sortino: number;

  // per-symbol
  perSymbol: SymbolSummary[];
}

export interface SymbolSummary {
  symbol: string;
  fills: number;
  realizedPnl: number;
  avgSlippageBps: number;
  winRate: number;
  profitFactor: number;
  maxPosition: number;
  volume: number;
}

// ── SessionTracker ──────────────────────────────────────────────────────────

export class SessionTracker {
  private readonly fills: FillRecord[] = [];
  private readonly curve: EquitySnapshot[] = [];
  private startEquity = 0;
  private startTs = 0;
  private totalQuotes = 0;
  private maxAbsPos = 0;

  constructor(
    private readonly snapshotIntervalMs: number = 10_000,
    private readonly logIntervalQuotes: number = 20,
  ) {}

  /** Call once during strategy init. */
  start(ctx: StrategyContext): void {
    this.startTs = ctx.clock.now();
    this.startEquity = ctx.account.equity().toNumber();
    this.sampleEquity(ctx);
  }

  /** Call after each quote cycle (cancel + place). */
  onQuote(
    ctx: StrategyContext,
    symbol: string,
    fair: number,
    quotes: QuoteResult[],
  ): void {
    this.totalQuotes++;

    for (const q of quotes) {
      for (const fill of q.result.fills) {
        const price = Number(fill.price);
        const size = Number(fill.size);

        const slippageBps = fair > 0
          ? ((q.side === "bid" ? price - fair : fair - price) / fair) * 10_000
          : 0;

        const pos = ctx.positions.get(symbol);
        const posAfter = pos
          ? (pos.isLong ? pos.baseSize.toNumber() : -pos.baseSize.toNumber())
          : 0;

        this.fills.push({
          ts: ctx.clock.now(),
          symbol,
          side: q.side,
          price,
          size,
          slippageBps,
          fairAtFill: fair,
          positionAfter: posAfter,
        });

        const absPos = Math.abs(posAfter);
        if (absPos > this.maxAbsPos) this.maxAbsPos = absPos;
      }
    }

    this.maybeSampleEquity(ctx);
    this.maybeLogProgress(ctx);
  }

  /** Call during strategy shutdown. Returns the full summary. */
  finish(ctx: StrategyContext): SessionSummary {
    this.sampleEquity(ctx);
    return this.computeSummary(ctx);
  }

  /** Format the summary as a console-friendly table. */
  static formatSummary(s: SessionSummary): string {
    const lines: string[] = [];
    const row = (label: string, value: string) =>
      lines.push(`  ${label.padEnd(22)}${value}`);

    lines.push("── Session Summary ─────────────────────────");
    row("Duration", fmtDur(s.durationMs));
    row("Start Equity", usd(s.startEquity));
    row("End Equity", usd(s.endEquity));
    row("Total Return", pct(s.totalReturn));
    lines.push("");
    row("Quotes", String(s.totalQuotes));
    row("Fills", String(s.totalFills));
    row("Fill Rate", pct(s.fillRate));
    row("Volume", usd(s.totalVolume));
    lines.push("");
    row("Realized PnL", usd(s.realizedPnl));
    row("Unrealized PnL", usd(s.unrealizedPnl));
    row("Net PnL", usd(s.netPnl));
    lines.push("");
    row("Win Rate", pct(s.winRate));
    row("Profit Factor", num(s.profitFactor));
    row("Avg Win", usd(s.avgWinUsd));
    row("Avg Loss", usd(s.avgLossUsd));
    row("Avg Slippage", `${num(s.avgSlippageBps)} bps`);
    lines.push("");
    row("Max Position", num(s.maxPosition, 4));
    row("Max Drawdown", pct(s.maxDrawdown));
    row("Max DD Duration", fmtDur(s.maxDrawdownDurationMs));
    row("Sharpe (hourly)", num(s.sharpe));
    row("Sortino (hourly)", num(s.sortino));

    if (s.perSymbol.length > 0) {
      lines.push("");
      lines.push("── Per Symbol ──────────────────────────────");
      for (const sym of s.perSymbol) {
        lines.push(`  ${sym.symbol}: ${sym.fills} fills, PnL ${usd(sym.realizedPnl)}, slip ${num(sym.avgSlippageBps)}bps, WR ${pct(sym.winRate)}, PF ${num(sym.profitFactor)}, maxPos ${num(sym.maxPosition, 4)}`);
      }
    }

    return lines.join("\n");
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private maybeSampleEquity(ctx: StrategyContext): void {
    const last = this.curve[this.curve.length - 1];
    if (last && ctx.clock.now() - last.ts < this.snapshotIntervalMs) return;
    this.sampleEquity(ctx);
  }

  private sampleEquity(ctx: StrategyContext): void {
    const positions = ctx.positions.list();
    let unrealizedPnl = 0;
    let totalPos = 0;
    for (const p of positions) {
      unrealizedPnl += p.unrealizedPnl.toNumber();
      totalPos += p.isLong ? p.baseSize.toNumber() : -p.baseSize.toNumber();
    }
    this.curve.push({
      ts: ctx.clock.now(),
      equity: ctx.account.equity().toNumber(),
      unrealizedPnl,
      position: totalPos,
    });
  }

  private maybeLogProgress(ctx: StrategyContext): void {
    if (this.totalQuotes % this.logIntervalQuotes !== 0) return;
    const equity = ctx.account.equity().toNumber();
    const ret = this.startEquity > 0
      ? (equity - this.startEquity) / this.startEquity
      : 0;
    (ctx as StrategyContext<unknown>).logger.info("session", {
      quotes: this.totalQuotes,
      fills: this.fills.length,
      fillRate: pct(this.fills.length / (this.totalQuotes * 2)),
      equity: equity.toFixed(2),
      ret: pct(ret),
    });
  }

  private computeSummary(ctx: StrategyContext): SessionSummary {
    const now = ctx.clock.now();
    const endEquity = ctx.account.equity().toNumber();
    const durationMs = now - this.startTs;
    const totalReturn = this.startEquity > 0
      ? (endEquity - this.startEquity) / this.startEquity
      : 0;

    const totalVolume = this.fills.reduce((s, f) => s + f.price * f.size, 0);

    const positions = ctx.positions.list();
    let unrealizedPnl = 0;
    for (const p of positions) unrealizedPnl += p.unrealizedPnl.toNumber();
    const realizedPnl = (endEquity - this.startEquity) - unrealizedPnl;

    const roundTrips = this.buildRoundTrips();
    const wins = roundTrips.filter(r => r.pnl > 0);
    const losses = roundTrips.filter(r => r.pnl < 0);
    const grossWin = wins.reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));

    // slippage
    const slippageSum = this.fills.reduce((s, f) => s + f.slippageBps, 0);
    const avgSlippageBps = this.fills.length > 0 ? slippageSum / this.fills.length : 0;

    // drawdown from equity curve
    const { maxDrawdown, maxDrawdownDurationMs } = this.computeDrawdown();

    // sharpe/sortino from hourly resampled returns
    const returns = this.resampleReturns(3_600_000);
    const periodsPerYear = 8760;
    const sharpe = this.computeSharpe(returns, periodsPerYear);
    const sortino = this.computeSortino(returns, periodsPerYear);

    const perSymbol = this.computePerSymbol();

    return {
      durationMs,
      startEquity: this.startEquity,
      endEquity,
      totalReturn,
      totalQuotes: this.totalQuotes,
      totalFills: this.fills.length,
      fillRate: this.totalQuotes > 0 ? this.fills.length / (this.totalQuotes * 2) : 0,
      totalVolume,
      realizedPnl,
      unrealizedPnl,
      netPnl: endEquity - this.startEquity,
      winRate: roundTrips.length > 0 ? wins.length / roundTrips.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgWinUsd: wins.length > 0 ? grossWin / wins.length : 0,
      avgLossUsd: losses.length > 0 ? grossLoss / losses.length : 0,
      avgSlippageBps,
      maxPosition: this.maxAbsPos,
      maxDrawdown,
      maxDrawdownDurationMs,
      sharpe,
      sortino,
      perSymbol,
    };
  }

  private buildRoundTrips(): { pnl: number }[] {
    const pos = new Map<string, { signed: number; entry: number }>();
    const trips: { pnl: number }[] = [];

    for (const f of this.fills) {
      const prev = pos.get(f.symbol) ?? { signed: 0, entry: 0 };
      const delta = f.side === "bid" ? f.size : -f.size;
      const newSigned = prev.signed + delta;

      if (prev.signed !== 0 && Math.sign(delta) !== Math.sign(prev.signed)) {
        const reduced = Math.min(f.size, Math.abs(prev.signed));
        const pnl = (f.price - prev.entry) * reduced * Math.sign(prev.signed);
        trips.push({ pnl });
      }

      if (Math.abs(newSigned) < 1e-12) {
        pos.set(f.symbol, { signed: 0, entry: 0 });
      } else if (Math.sign(newSigned) === Math.sign(delta) && Math.sign(delta) !== Math.sign(prev.signed)) {
        pos.set(f.symbol, { signed: newSigned, entry: f.price });
      } else if (Math.sign(newSigned) === Math.sign(prev.signed)) {
        const avgEntry = Math.abs(newSigned) > 1e-12
          ? (prev.entry * Math.abs(prev.signed) + f.price * f.size) / (Math.abs(prev.signed) + f.size)
          : f.price;
        pos.set(f.symbol, { signed: newSigned, entry: Math.sign(delta) === Math.sign(prev.signed) ? avgEntry : prev.entry });
      } else {
        pos.set(f.symbol, { signed: newSigned, entry: f.price });
      }
    }
    return trips;
  }

  private computeDrawdown(): { maxDrawdown: number; maxDrawdownDurationMs: number } {
    if (this.curve.length < 2) return { maxDrawdown: 0, maxDrawdownDurationMs: 0 };

    let peak = this.curve[0].equity;
    let peakTs = this.curve[0].ts;
    let maxDd = 0;
    let maxDdDur = 0;

    for (const s of this.curve) {
      if (s.equity >= peak) {
        const dur = s.ts - peakTs;
        if (dur > maxDdDur && maxDd > 0) maxDdDur = dur;
        peak = s.equity;
        peakTs = s.ts;
      } else {
        const dd = (peak - s.equity) / peak;
        if (dd > maxDd) maxDd = dd;
      }
    }

    const last = this.curve[this.curve.length - 1];
    if (last.equity < peak) {
      const dur = last.ts - peakTs;
      if (dur > maxDdDur) maxDdDur = dur;
    }

    return { maxDrawdown: maxDd, maxDrawdownDurationMs: maxDdDur };
  }

  private resampleReturns(periodMs: number): number[] {
    if (this.curve.length < 2) return [];
    const t0 = this.curve[0].ts;
    const tN = this.curve[this.curve.length - 1].ts;
    if (tN - t0 < periodMs) return [];

    const returns: number[] = [];
    let prevEq = this.curve[0].equity;
    let nextBoundary = t0 + periodMs;

    for (const s of this.curve) {
      if (s.ts >= nextBoundary) {
        if (prevEq > 0) returns.push((s.equity - prevEq) / prevEq);
        prevEq = s.equity;
        nextBoundary += periodMs;
      }
    }
    return returns;
  }

  private computeSharpe(returns: number[], periodsPerYear: number): number {
    if (returns.length < 2) return NaN;
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    return std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : (mean > 0 ? Infinity : 0);
  }

  private computeSortino(returns: number[], periodsPerYear: number): number {
    if (returns.length < 2) return NaN;
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const downside = returns.filter(r => r < 0);
    if (downside.length === 0) return mean > 0 ? Infinity : 0;
    const dsVar = downside.reduce((s, r) => s + r ** 2, 0) / returns.length;
    const dsStd = Math.sqrt(dsVar);
    return dsStd > 0 ? (mean / dsStd) * Math.sqrt(periodsPerYear) : (mean > 0 ? Infinity : 0);
  }

  private computePerSymbol(): SymbolSummary[] {
    const symbols = new Set(this.fills.map(f => f.symbol));
    const out: SymbolSummary[] = [];

    for (const symbol of symbols) {
      const symFills = this.fills.filter(f => f.symbol === symbol);
      const trips = this.buildSymbolRoundTrips(symFills);
      const wins = trips.filter(r => r.pnl > 0);
      const losses = trips.filter(r => r.pnl < 0);
      const grossWin = wins.reduce((s, r) => s + r.pnl, 0);
      const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));

      const volume = symFills.reduce((s, f) => s + f.price * f.size, 0);
      const slipSum = symFills.reduce((s, f) => s + f.slippageBps, 0);
      let maxPos = 0;
      for (const f of symFills) {
        const ap = Math.abs(f.positionAfter);
        if (ap > maxPos) maxPos = ap;
      }

      out.push({
        symbol,
        fills: symFills.length,
        realizedPnl: trips.reduce((s, r) => s + r.pnl, 0),
        avgSlippageBps: symFills.length > 0 ? slipSum / symFills.length : 0,
        winRate: trips.length > 0 ? wins.length / trips.length : 0,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
        maxPosition: maxPos,
        volume,
      });
    }

    return out.sort((a, b) => b.realizedPnl - a.realizedPnl);
  }

  private buildSymbolRoundTrips(fills: FillRecord[]): { pnl: number }[] {
    let signed = 0;
    let entry = 0;
    const trips: { pnl: number }[] = [];

    for (const f of fills) {
      const delta = f.side === "bid" ? f.size : -f.size;
      const newSigned = signed + delta;

      if (signed !== 0 && Math.sign(delta) !== Math.sign(signed)) {
        const reduced = Math.min(f.size, Math.abs(signed));
        trips.push({ pnl: (f.price - entry) * reduced * Math.sign(signed) });
      }

      if (Math.abs(newSigned) < 1e-12) {
        signed = 0; entry = 0;
      } else if (Math.sign(newSigned) === Math.sign(delta) && delta !== 0 && signed !== 0 && Math.sign(delta) === Math.sign(signed)) {
        entry = (entry * Math.abs(signed) + f.price * f.size) / (Math.abs(signed) + f.size);
        signed = newSigned;
      } else {
        entry = Math.abs(newSigned) > 1e-12 && signed !== 0 ? entry : f.price;
        signed = newSigned;
      }
    }
    return trips;
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function pct(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return `${(v * 100).toFixed(2)}%`;
}

function num(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return String(v);
  return v.toFixed(dp);
}

function usd(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtDur(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
