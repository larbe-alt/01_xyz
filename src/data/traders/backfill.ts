/**
 * Backfill driver — drains `iterateTrades` and writes identified trades to
 * data/<env>/trades_id/<SYMBOL>/*.parquet in chunks (bounded memory).
 *
 * Run on the Mac, never the VPS (CLAUDE.md): it only needs the SDK + a mainnet
 * RPC, no recorder data. Chunk files are named <firstId>-<lastId>.parquet so
 * they glob with *.parquet, stay non-overlapping, and make resume obvious.
 *
 *   npm run traders:backfill -- --markets ETHUSD,HYPEUSD --since 2026-06-01
 *   npm run traders:backfill -- --markets ETHUSD --since 2026-06-01 --until 2026-06-10 --chunk 50000
 */
import "../../utils/polyfills.js";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import duckdb from "duckdb";
import type { Nord, TradeFromApi } from "@n1xyz/nord-ts";
import { getNord, getConfig } from "../../client.js";
import { initMarkets, symbolToId, idToSymbol } from "../../registry/markets.js";
import { getSharedDb, closeSharedDb } from "../recorder/writers.js";
import { createLogger } from "../../utils/logger.js";
import {
  TRADES_SCHEMA_VERSION,
  IDENTIFIED_TRADE_COLUMNS,
  type IdentifiedTrade,
} from "./schema.js";
import { iterateTrades } from "./client.js";

const log = createLogger("traders:backfill");

function toRecord(t: TradeFromApi): IdentifiedTrade {
  return {
    v: TRADES_SCHEMA_VERSION,
    symbol: idToSymbol(t.marketId),
    market_id: t.marketId,
    ts: Date.parse(t.time),
    trade_id: t.tradeId,
    action_id: t.actionId,
    order_id: t.orderId,
    taker_id: t.takerId,
    maker_id: t.makerId,
    taker_side: t.takerSide,
    price: t.price,
    base_size: t.baseSize,
    taker_fee: t.takerFee ?? null,
    maker_fee: t.makerFee ?? null,
  };
}

function dbExec(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) =>
    db.exec(sql, (err: Error | null) => (err ? reject(err) : resolve())),
  );
}

/** Write one chunk to <outDir>/<firstId>-<lastId>.parquet via COPY-from-ndjson. */
async function writeChunk(db: duckdb.Database, outDir: string, rows: IdentifiedTrade[]): Promise<void> {
  if (rows.length === 0) return;
  mkdirSync(outDir, { recursive: true });
  const first = rows[0]!.trade_id;
  const last = rows[rows.length - 1]!.trade_id;
  const outPath = path.join(outDir, `${first}-${last}.parquet`);
  const tmpPath = outPath + ".tmp.ndjson";

  writeFileSync(tmpPath, rows.map((r) => JSON.stringify(r)).join("\n"));
  const sql = `COPY (
    SELECT * FROM read_json(
      '${tmpPath.replace(/'/g, "''")}',
      format = 'newline_delimited',
      columns = ${IDENTIFIED_TRADE_COLUMNS}
    ) ORDER BY trade_id
  ) TO '${outPath.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION 'zstd')`;

  try {
    await dbExec(db, sql);
    log.info("Chunk written", { file: path.basename(outPath), rows: rows.length });
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/** Highest trade_id already on disk for this market, or null if none. */
async function lastTradeIdOnDisk(db: duckdb.Database, outDir: string): Promise<number | null> {
  if (!existsSync(outDir)) return null;
  const glob = `${outDir.replace(/'/g, "''")}/*.parquet`;
  const rows = await new Promise<any[]>((resolve, reject) =>
    db.all(
      `SELECT max(trade_id) AS m FROM read_parquet('${glob}')`,
      (err: Error | null, r: any[]) => (err ? reject(err) : resolve(r)),
    ),
  ).catch(() => [] as any[]); // no files yet → glob errors → treat as empty
  const m = rows[0]?.m;
  return m == null ? null : Number(m);
}

export interface BackfillOptions {
  market: string;
  since?: string;
  until?: string;
  chunkSize: number;
  outDir: string;
  env: string;
  /** Resume: skip trades already on disk, pulling only newer ones. */
  resume?: boolean;
}

export async function backfillMarket(nord: Nord, opts: BackfillOptions): Promise<number> {
  const marketId = symbolToId(opts.market);
  const outDir = path.join(opts.outDir, opts.env, "trades_id", opts.market);
  const db = getSharedDb();

  // Pages come back newest-first, so resume = stop once we reach a known trade.
  const stopAt = opts.resume ? await lastTradeIdOnDisk(db, outDir) : null;
  log.info("Backfilling", {
    market: opts.market, marketId, since: opts.since, until: opts.until,
    resumeFrom: stopAt,
  });

  let buffer: IdentifiedTrade[] = [];
  let total = 0;
  for await (const t of iterateTrades(
    nord,
    { marketId, since: opts.since, until: opts.until, pageSize: 100 },
    (info) => {
      if (info.pages % 20 === 0) log.info("Progress", { market: opts.market, ...info });
    },
  )) {
    if (stopAt != null && t.tradeId <= stopAt) break; // reached known data
    buffer.push(toRecord(t));
    total++;
    if (buffer.length >= opts.chunkSize) {
      await writeChunk(db, outDir, buffer);
      buffer = [];
    }
  }
  await writeChunk(db, outDir, buffer);

  log.info("Backfill complete", { market: opts.market, newTrades: total });
  return total;
}

interface Args {
  markets: string[];
  since?: string;
  until?: string;
  chunkSize: number;
  outDir: string;
  resume: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let markets: string[] = [];
  let since: string | undefined;
  let until: string | undefined;
  let chunkSize = 50_000;
  let outDir = "./data";
  let resume = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--markets":
      case "-m":
        markets = args[++i]!.split(",").map((s) => s.trim());
        break;
      case "--since":
        since = args[++i];
        break;
      case "--until":
        until = args[++i];
        break;
      case "--chunk":
        chunkSize = Number(args[++i]);
        break;
      case "--out":
      case "-o":
        outDir = args[++i]!;
        break;
      case "--resume":
        resume = true;
        break;
      default:
        log.error("Unknown arg", { arg: args[i] });
        process.exit(1);
    }
  }

  if (markets.length === 0) {
    log.error("--markets required (e.g. --markets ETHUSD,HYPEUSD)");
    process.exit(1);
  }
  return { markets, since, until, chunkSize, outDir, resume };
}

async function main() {
  const { markets, since, until, chunkSize, outDir, resume } = parseArgs();
  const cfg = getConfig();

  log.info("Starting trade backfill", { network: cfg.network, markets, since, until, outDir, resume });

  const nord = await getNord();
  initMarkets(nord);

  let grand = 0;
  for (const market of markets) {
    grand += await backfillMarket(nord, { market, since, until, chunkSize, outDir, env: cfg.network, resume });
  }

  await closeSharedDb();
  log.info("Done", { totalTrades: grand });
}

main().catch((err) => {
  log.error("Fatal", { error: err.message, stack: err.stack });
  process.exit(1);
});
