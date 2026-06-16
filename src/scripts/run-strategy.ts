/**
 * CLI: run a named strategy from a JSON config file.
 *
 *   npm run strategy -- --config examples/noop.config.json
 *   npm run strategy -- --config cfg.json --strategy noop --dry-run
 *   npm run strategy -- --config cfg.json --replay ./data
 *
 * Config file shape (StrategyFileConfig): { strategy, run, risk, params?, dryRun?, replay? }.
 * --strategy / --dry-run / --replay override the file. Replay forces dry-run.
 */
import "../utils/polyfills.js";
import { readFileSync } from "node:fs";
import { createStrategy, registeredStrategies } from "../engine/registry.js";
import "../strategies/index.js"; // self-registers built-in strategies
import { StrategyRunner } from "../engine/runner.js";
import type { StrategyFileConfig } from "../engine/types.js";

interface CliArgs {
  config?: string;
  strategy?: string;
  dryRun: boolean;
  replay?: string | true;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--strategy") args.strategy = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--replay") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.replay = next;
        i++;
      } else {
        args.replay = true;
      }
    }
  }
  return args;
}

function usage(): never {
  console.error(
    "Usage: npm run strategy -- --config <cfg.json> [--strategy <name>] [--dry-run] [--replay <baseDir>]",
  );
  console.error(`Registered strategies: ${registeredStrategies().join(", ") || "(none)"}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) usage();

const file = JSON.parse(readFileSync(args.config, "utf8")) as StrategyFileConfig;
const strategyName = args.strategy ?? file.strategy;
if (!strategyName) {
  console.error("No strategy specified (--strategy or config.strategy)");
  usage();
}

let strategy;
try {
  strategy = createStrategy(strategyName);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const replayBase =
  typeof args.replay === "string" ? args.replay : args.replay ? (file.replay?.baseDir ?? "./data") : undefined;

const replay = replayBase
  ? {
      baseDir: replayBase,
      env: file.replay?.env,
      from: file.replay?.from,
      to: file.replay?.to,
      speed: file.replay?.speed,
    }
  : undefined;

const runner = new StrategyRunner(strategy, {
  run: file.run,
  risk: file.risk,
  params: file.params,
  // Replay can never place real orders → force dry-run.
  dryRun: args.dryRun || !!file.dryRun || !!replay,
  replay,
});

await runner.start();
