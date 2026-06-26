import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createStrategy, registeredStrategies } from "../engine/registry.js";
import "../strategies/index.js";
import { loadBacktestData, runBacktest } from "../backtest/runner.js";
import { formatReport, toJSON } from "../backtest/report.js";
import type { BacktestConfig } from "../backtest/config.js";

function usage(): never {
  console.error("Usage: npm run backtest -- --config <cfg.json>");
  console.error(`Registered strategies: ${registeredStrategies().join(", ") || "(none)"}`);
  process.exit(1);
}

let configPath: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--config") configPath = process.argv[++i];
}
if (!configPath) usage();

const config = JSON.parse(readFileSync(configPath, "utf8")) as BacktestConfig;

if (!config.strategy) {
  console.error("Config must specify a strategy name");
  process.exit(1);
}

let strategy;
try {
  strategy = createStrategy(config.strategy);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

console.error(`Loading data for ${config.markets.map((m) => m.symbol).join(", ")}...`);
const events = await loadBacktestData(config);
console.error(`Loaded ${events.length} events. Running backtest...`);

const t0 = performance.now();
const { report, trades } = await runBacktest(config, events, strategy);
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

console.log(formatReport(report));
console.error(`\nCompleted in ${elapsed}s (${events.length} events)`);

const outDir = path.join("results", `bt_${Date.now()}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "report.json"), toJSON(report));
writeFileSync(path.join(outDir, "trades.json"), JSON.stringify(trades, null, 2));
writeFileSync(path.join(outDir, "config.json"), JSON.stringify(config, null, 2));
console.error(`Results saved to ${outDir}/`);
