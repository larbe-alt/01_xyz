/**
 * Report formatters — console summary table + JSON export.
 */
import type { FullReport, BacktestMetrics, SymbolMetrics } from "./metrics.js";

export function formatReport(report: FullReport): string {
  const lines: string[] = [];
  lines.push(formatAggregate(report.aggregate));
  if (report.perSymbol.length > 1) {
    lines.push("");
    lines.push(formatPerSymbol(report.perSymbol));
  }
  return lines.join("\n");
}

function formatAggregate(m: BacktestMetrics): string {
  const dur = formatDuration(m.durationMs);
  const ddDur = formatDuration(m.maxDrawdownDurationMs);

  const rows: [string, string][] = [
    ["Duration", dur],
    ["Total Return", pct(m.totalReturn)],
    ["CAGR", pct(m.cagr)],
    ["", ""],
    ["Sharpe", num(m.sharpe, 2)],
    ["Sortino", num(m.sortino, 2)],
    ["Calmar", num(m.calmar, 2)],
    ["Omega", num(m.omega, 2)],
    ["", ""],
    ["Max Drawdown", pct(m.maxDrawdown)],
    ["Max DD Duration", ddDur],
    ["", ""],
    ["Trades", String(m.totalTrades)],
    ["Win Rate", pct(m.winRate)],
    ["Profit Factor", num(m.profitFactor, 2)],
    ["Avg Win", usd(m.avgWin)],
    ["Avg Loss", usd(m.avgLoss)],
    ["", ""],
    ["Total Fees", usd(m.totalFees)],
    ["Fee Drag", pct(m.feeDrag)],
    ["Total Funding", usd(m.totalFunding)],
    ["Total Slippage", usd(m.totalSlippage)],
    ["Avg Slippage", `${num(m.avgSlippageBps, 2)} bps`],
    ["", ""],
    ["Max Position", num(m.maxPosition, 4)],
    ["Exposure", pct(m.exposure)],
    ["Turnover", `${num(m.turnover, 1)}x`],
  ];

  const maxLabel = Math.max(...rows.map(([l]) => l.length));
  const lines = ["── Backtest Results ─────────────────────"];
  for (const [label, value] of rows) {
    if (label === "") {
      lines.push("");
      continue;
    }
    lines.push(`  ${label.padEnd(maxLabel + 2)}${value}`);
  }
  return lines.join("\n");
}

function formatPerSymbol(symbols: SymbolMetrics[]): string {
  const header = ["Symbol", "Trades", "PnL", "Fees", "Funding", "Slip bps", "WinRate", "PF", "MaxPos"];
  const rows = symbols.map((s) => [
    s.symbol,
    String(s.trades),
    usd(s.realizedPnl),
    usd(s.fees),
    usd(s.funding),
    num(s.avgSlippageBps, 2),
    pct(s.winRate),
    num(s.profitFactor, 2),
    num(s.maxPosition, 4),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  const fmt = (row: string[]) => row.map((c, i) => c.padStart(widths[i])).join("  ");

  return ["── Per-Symbol ──────────────────────────", fmt(header), sep, ...rows.map(fmt)].join("\n");
}

export function toJSON(report: FullReport): string {
  return JSON.stringify(report, (_k, v) => (v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : Number.isNaN(v) ? "NaN" : v), 2);
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function pct(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return `${(v * 100).toFixed(2)}%`;
}

function num(v: number, dp: number): string {
  if (!Number.isFinite(v)) return String(v);
  return v.toFixed(dp);
}

function usd(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function formatDuration(ms: number): string {
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
