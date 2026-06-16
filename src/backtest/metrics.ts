/**
 * Metrics calculator — pure functions over the equity curve + trade log.
 *
 * All inputs come from PnLEngine; no live dependencies. Metrics are computed
 * at two levels: aggregate (whole backtest) and per-symbol.
 */
import type { EquitySample, TradeRecord, FundingRecord } from "./pnl.js";

// ── Output types ─────────────────────────────────────────────────────────────

export interface BacktestMetrics {
  // Return
  totalReturn: number;
  cagr: number;

  // Risk-adjusted
  sharpe: number;
  sortino: number;
  calmar: number;
  omega: number;

  // Drawdown
  maxDrawdown: number;
  maxDrawdownDurationMs: number;

  // Trade-level
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;

  // Costs
  totalFees: number;
  feeDrag: number;
  totalFunding: number;

  // Slippage
  totalSlippage: number;
  avgSlippageBps: number;

  // Operational
  maxPosition: number;
  exposure: number;
  turnover: number;
  durationMs: number;
}

export interface SymbolMetrics {
  symbol: string;
  trades: number;
  realizedPnl: number;
  fees: number;
  funding: number;
  slippage: number;
  avgSlippageBps: number;
  winRate: number;
  profitFactor: number;
  maxPosition: number;
  notional: number;
}

export interface FullReport {
  aggregate: BacktestMetrics;
  perSymbol: SymbolMetrics[];
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface MetricsConfig {
  /** Resample period for Sharpe/Sortino/Omega in ms (default: 1 hour). */
  resampleMs?: number;
  /** Omega threshold return per period (default: 0). */
  omegaThreshold?: number;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function computeMetrics(
  curve: readonly EquitySample[],
  trades: readonly TradeRecord[],
  fundingLog: readonly FundingRecord[],
  pnlStats: {
    initialEquity: number;
    finalEquity: number;
    totalNotional: number;
    maxAbsPosition: number;
    exposureMs: number;
    totalDurationMs: number;
    totalFunding: number;
  },
  config?: MetricsConfig,
): FullReport {
  const aggregate = computeAggregate(curve, trades, fundingLog, pnlStats, config);
  const perSymbol = computePerSymbol(trades, fundingLog);
  return { aggregate, perSymbol };
}

// ── Aggregate metrics ────────────────────────────────────────────────────────

function computeAggregate(
  curve: readonly EquitySample[],
  trades: readonly TradeRecord[],
  fundingLog: readonly FundingRecord[],
  s: {
    initialEquity: number;
    finalEquity: number;
    totalNotional: number;
    maxAbsPosition: number;
    exposureMs: number;
    totalDurationMs: number;
    totalFunding: number;
  },
  config?: MetricsConfig,
): BacktestMetrics {
  const totalReturn = s.initialEquity > 0 ? (s.finalEquity - s.initialEquity) / s.initialEquity : 0;
  const durationMs = s.totalDurationMs;
  const yearsElapsed = durationMs / (365.25 * 24 * 3600 * 1000);
  const cagr = yearsElapsed > 0 && s.initialEquity > 0
    ? Math.pow(s.finalEquity / s.initialEquity, 1 / yearsElapsed) - 1
    : 0;

  const { maxDrawdown, maxDrawdownDurationMs } = computeDrawdown(curve);

  const resampleMs = config?.resampleMs ?? 3_600_000;
  const returns = resampleReturns(curve, resampleMs);
  const periodsPerYear = (365.25 * 24 * 3600 * 1000) / resampleMs;

  const sharpe = computeSharpe(returns, periodsPerYear);
  const sortino = computeSortino(returns, periodsPerYear);
  const calmar = maxDrawdown > 0 ? cagr / maxDrawdown : (cagr > 0 ? Infinity : 0);
  const omega = computeOmega(returns, config?.omegaThreshold ?? 0);

  const reducingTrades = trades.filter((t) => t.realizedPnl !== 0);
  const wins = reducingTrades.filter((t) => t.realizedPnl > 0);
  const losses = reducingTrades.filter((t) => t.realizedPnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0));

  const totalFees = trades.reduce((s, t) => s + t.fee, 0);
  const totalSlippage = trades.reduce((s, t) => s + t.slippage * t.size, 0);
  const totalSlippageNotional = trades.reduce((s, t) => s + t.price * t.size, 0);
  const avgSlippageBps = totalSlippageNotional > 0
    ? (totalSlippage / totalSlippageNotional) * 10_000
    : 0;

  return {
    totalReturn,
    cagr,
    sharpe,
    sortino,
    calmar,
    omega,
    maxDrawdown,
    maxDrawdownDurationMs,
    totalTrades: trades.length,
    winRate: reducingTrades.length > 0 ? wins.length / reducingTrades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length > 0 ? grossWin / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    totalFees,
    feeDrag: s.initialEquity > 0 ? totalFees / s.initialEquity : 0,
    totalFunding: s.totalFunding,
    totalSlippage,
    avgSlippageBps,
    maxPosition: s.maxAbsPosition,
    exposure: durationMs > 0 ? s.exposureMs / durationMs : 0,
    turnover: s.initialEquity > 0 ? s.totalNotional / s.initialEquity : 0,
    durationMs,
  };
}

// ── Per-symbol breakdown ─────────────────────────────────────────────────────

function computePerSymbol(
  trades: readonly TradeRecord[],
  fundingLog: readonly FundingRecord[],
): SymbolMetrics[] {
  const symbols = new Set<string>();
  for (const t of trades) symbols.add(t.symbol);
  for (const f of fundingLog) symbols.add(f.symbol);

  const out: SymbolMetrics[] = [];
  for (const symbol of symbols) {
    const symTrades = trades.filter((t) => t.symbol === symbol);
    const symFunding = fundingLog.filter((f) => f.symbol === symbol);

    const reducing = symTrades.filter((t) => t.realizedPnl !== 0);
    const wins = reducing.filter((t) => t.realizedPnl > 0);
    const losses = reducing.filter((t) => t.realizedPnl < 0);
    const grossWin = wins.reduce((s, t) => s + t.realizedPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0));

    const fees = symTrades.reduce((s, t) => s + t.fee, 0);
    const funding = symFunding.reduce((s, f) => s + f.payment, 0);
    const slippage = symTrades.reduce((s, t) => s + t.slippage * t.size, 0);
    const notional = symTrades.reduce((s, t) => s + t.price * t.size, 0);
    const avgSlippageBps = notional > 0 ? (slippage / notional) * 10_000 : 0;

    let maxPos = 0;
    for (const t of symTrades) {
      const ap = Math.abs(t.positionAfter);
      if (ap > maxPos) maxPos = ap;
    }

    out.push({
      symbol,
      trades: symTrades.length,
      realizedPnl: reducing.reduce((s, t) => s + t.realizedPnl, 0),
      fees,
      funding,
      slippage,
      avgSlippageBps,
      winRate: reducing.length > 0 ? wins.length / reducing.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      maxPosition: maxPos,
      notional,
    });
  }

  return out.sort((a, b) => b.realizedPnl - a.realizedPnl);
}

// ── Drawdown ─────────────────────────────────────────────────────────────────

function computeDrawdown(curve: readonly EquitySample[]): {
  maxDrawdown: number;
  maxDrawdownDurationMs: number;
} {
  if (curve.length < 2) return { maxDrawdown: 0, maxDrawdownDurationMs: 0 };

  let peak = curve[0].equity;
  let peakTs = curve[0].ts;
  let maxDd = 0;
  let maxDdDur = 0;

  for (const s of curve) {
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

  // If we ended in a drawdown, check that duration too
  const lastTs = curve[curve.length - 1].ts;
  if (curve[curve.length - 1].equity < peak) {
    const dur = lastTs - peakTs;
    if (dur > maxDdDur) maxDdDur = dur;
  }

  return { maxDrawdown: maxDd, maxDrawdownDurationMs: maxDdDur };
}

// ── Resampling + return series ───────────────────────────────────────────────

function resampleReturns(curve: readonly EquitySample[], periodMs: number): number[] {
  if (curve.length < 2) return [];

  const t0 = curve[0].ts;
  const tN = curve[curve.length - 1].ts;
  if (tN - t0 < periodMs) return [];

  const returns: number[] = [];
  let prevEq = curve[0].equity;
  let nextBoundary = t0 + periodMs;
  let lastEq = curve[0].equity;

  for (const s of curve) {
    lastEq = s.equity;
    if (s.ts >= nextBoundary) {
      if (prevEq > 0) returns.push((lastEq - prevEq) / prevEq);
      prevEq = lastEq;
      nextBoundary += periodMs;
    }
  }

  return returns;
}

// ── Sharpe ───────────────────────────────────────────────────────────────────

function computeSharpe(returns: number[], periodsPerYear: number): number {
  if (returns.length < 2) return NaN;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : (mean > 0 ? Infinity : 0);
}

// ── Sortino ──────────────────────────────────────────────────────────────────

function computeSortino(returns: number[], periodsPerYear: number): number {
  if (returns.length < 2) return NaN;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return mean > 0 ? Infinity : 0;
  const dsVariance = downside.reduce((s, r) => s + r ** 2, 0) / returns.length;
  const dsStd = Math.sqrt(dsVariance);
  return dsStd > 0 ? (mean / dsStd) * Math.sqrt(periodsPerYear) : (mean > 0 ? Infinity : 0);
}

// ── Omega ────────────────────────────────────────────────────────────────────

function computeOmega(returns: number[], threshold: number): number {
  if (returns.length === 0) return NaN;
  let gains = 0;
  let losses = 0;
  for (const r of returns) {
    if (r > threshold) gains += r - threshold;
    else losses += threshold - r;
  }
  return losses > 0 ? gains / losses : (gains > 0 ? Infinity : 1);
}
