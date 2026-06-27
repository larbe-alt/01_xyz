import "../utils/polyfills.js";
import { getNord, getConfig } from "../client.js";
import { initMarkets } from "../registry/markets.js";
import { initTokens } from "../registry/tokens.js";
import { LiveFeed } from "../data/feed.js";
import { Recorder } from "../data/recorder/recorder.js";
import { closeSharedDb } from "../data/recorder/writers.js";
import { createLogger } from "../utils/logger.js";
import type { StreamType } from "../data/recorder/schema.js";

const log = createLogger("record");

const VALID_STREAMS = new Set<StreamType>(["trade", "delta", "snapshot", "candle", "mark"]);

function parseArgs(): { markets: string[]; streams: StreamType[]; outDir: string; rotationMin: number; markPollSec: number } {
  const args = process.argv.slice(2);
  let markets: string[] = [];
  let streams: StreamType[] = [];
  let outDir = "./data";
  let rotationMin = 5;
  let markPollSec = 2;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--markets":
      case "-m":
        markets = args[++i]!.split(",").map((s) => s.trim());
        break;
      case "--streams":
      case "-s":
        streams = args[++i]!.split(",").map((s) => s.trim()) as StreamType[];
        break;
      case "--out":
      case "-o":
        outDir = args[++i]!;
        break;
      case "--rotation":
      case "-r":
        rotationMin = Number(args[++i]);
        break;
      case "--mark-poll-sec":
        markPollSec = Number(args[++i]);
        break;
      default:
        log.error("Unknown arg", { arg: args[i] });
        process.exit(1);
    }
  }

  if (markets.length === 0) {
    log.error("--markets required (e.g. --markets BTC-PERP,ETH-PERP)");
    process.exit(1);
  }
  if (streams.length === 0) {
    // candle omitted by default: OHLCV is reconstructable from the trade stream.
    streams = ["trade", "delta", "snapshot", "mark"];
  }
  for (const s of streams) {
    if (!VALID_STREAMS.has(s)) {
      log.error("Invalid stream", { stream: s, valid: [...VALID_STREAMS] });
      process.exit(1);
    }
  }
  if (!Number.isFinite(markPollSec) || markPollSec <= 0) {
    log.error("--mark-poll-sec must be a positive number", { markPollSec });
    process.exit(1);
  }

  return { markets, streams, outDir, rotationMin, markPollSec };
}

async function main() {
  const { markets, streams, outDir, rotationMin, markPollSec } = parseArgs();
  const cfg = getConfig();

  log.info("Starting recorder", { network: cfg.network, markets, streams, outDir, rotationMin, markPollSec });

  const nord = await getNord();
  await initMarkets(nord);
  await initTokens(nord);

  const feedSubs: {
    trades?: string[];
    deltas?: string[];
    candles?: { symbol: string; resolution: "1" }[];
  } = {};

  if (streams.includes("trade")) feedSubs.trades = markets;
  if (streams.includes("delta") || streams.includes("snapshot")) feedSubs.deltas = markets;
  if (streams.includes("candle")) feedSubs.candles = markets.map((s) => ({ symbol: s, resolution: "1" as const }));

  const feed = new LiveFeed(nord, feedSubs);
  const recorder = new Recorder(nord, feed, {
    markets,
    streams,
    baseDir: outDir,
    env: cfg.network,
    rotationMs: rotationMin * 60_000,
    markPollMs: markPollSec * 1000,
  });

  feed.on("connected", () => log.info("Feed connected"));
  feed.on("disconnected", () => log.warn("Feed disconnected"));
  feed.on("reconnecting", (attempt: number) => log.info("Reconnecting", { attempt }));
  feed.on("error", (err: Error) => log.error("Feed error", { error: err.message }));

  recorder.start();
  feed.start();

  log.info("Recording... Press Ctrl+C to stop");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      log.info("Shutting down...");
      resolve();
    });
    process.on("SIGTERM", () => {
      log.info("Shutting down...");
      resolve();
    });
  });

  await recorder.stop();
  feed.close();
  await closeSharedDb();
  log.info("Done");
}

main().catch((err) => {
  log.error("Fatal", { error: err.message, stack: err.stack });
  process.exit(1);
});
