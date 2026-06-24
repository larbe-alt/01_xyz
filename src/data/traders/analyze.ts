/**
 * One-call trader analysis. Pulls the last N days of identified trades from the
 * getTrades REST endpoint, runs them through the TraderRegistry, and prints a
 * full report: top-N by volume, by PnL, by win-rate, plus maker-vs-taker
 * metrics. No backfill step — fetches and analyzes in one shot.
 *
 *   npm run traders:analyze -- --markets ETHUSD,HYPEUSD --days 2
 *   npm run traders:analyze -- --markets ETHUSD --days 7 --top 10 --min-closes 5
 */
import "../../utils/polyfills.js";
import type { Nord, TradeFromApi } from "@n1xyz/nord-ts";
import { getNord, getConfig } from "../../client.js";
import { initMarkets, symbolToId } from "../../registry/markets.js";
import { createLogger } from "../../utils/logger.js";
import { iterateTrades } from "./client.js";
import { TraderRegistry, type TraderStats } from "./registry.js";

const log = createLogger("traders:analyze");

interface Args {
  markets: string[];
  days: number;
  top: number;
  minCloses: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let markets: string[] = [];
  let days = 2;
  let top = 10;
  let minCloses = 5;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--markets":
      case "-m":
        markets = args[++i]!.split(",").map((s) => s.trim());
        break;
      case "--days":
      case "-d":
        days = Number(args[++i]);
        break;
      case "--top":
        top = Number(args[++i]);
        break;
      case "--min-closes":
        minCloses = Number(args[++i]);
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
  return { markets, days, top, minCloses };
}

const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (n: number) => (n * 100).toFixed(1) + "%";
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

function section(title: string): void {
  console.log("\n" + title);
  console.log("─".repeat(title.length));
}

function table(rows: string[][], headers: string[]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? pad(c, widths[i]!) : padL(c, widths[i]!))).join("  ");
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

function report(reg: TraderRegistry, args: Args): void {
  const all = reg.all();
  if (all.length === 0) {
    console.log("\nNo trades in the selected window.");
    return;
  }

  const byVolume = [...all].sort((a, b) => reg.totalNotional(b) - reg.totalNotional(a)).slice(0, args.top);
  section(`Top ${args.top} by volume (notional)`);
  table(
    byVolume.map((s) => [
      String(s.accountId),
      usd(reg.totalNotional(s)),
      pct(reg.makerShare(s)),
      String(s.takerCount + s.makerCount),
    ]),
    ["account", "notional", "maker%", "fills"],
  );

  const byPnl = [...all].sort((a, b) => reg.totalPnl(b) - reg.totalPnl(a)).slice(0, args.top);
  section(`Top ${args.top} by PnL (realized + unrealized)`);
  table(
    byPnl.map((s) => [
      String(s.accountId),
      usd(reg.totalPnl(s)),
      usd(s.realizedPnl),
      usd(reg.unrealized(s)),
      reg.coverage(s),
    ]),
    ["account", "totalPnl", "realized", "unreal", "coverage"],
  );

  const byWin = all
    .filter((s) => s.wins + s.losses >= args.minCloses)
    .sort((a, b) => reg.winRate(b) - reg.winRate(a))
    .slice(0, args.top);
  section(`Top ${args.top} by win-rate (min ${args.minCloses} closing fills)`);
  if (byWin.length === 0) {
    console.log("(no accounts with enough closing fills in window)");
  } else {
    table(
      byWin.map((s) => [
        String(s.accountId),
        pct(reg.winRate(s)),
        `${s.wins}/${s.wins + s.losses}`,
        usd(reg.totalPnl(s)),
      ]),
      ["account", "winRate", "wins/closes", "totalPnl"],
    );
  }

  // Maker-vs-taker market metrics
  let takerBase = 0, makerBase = 0, takerNotional = 0, makerNotional = 0, takerFee = 0, makerFee = 0;
  let pureMakers = 0, pureTakers = 0, mixed = 0;
  for (const s of all) {
    takerBase += s.takerBase; makerBase += s.makerBase;
    takerNotional += s.takerNotional; makerNotional += s.makerNotional;
    // feesPaid mixes both; split by re-deriving is lossy, so report total fees only below
    const share = reg.makerShare(s);
    if (share >= 0.95) pureMakers++; else if (share <= 0.05) pureTakers++; else mixed++;
  }
  const totalNotional = takerNotional + makerNotional;
  section("Maker vs taker (market-wide)");
  table(
    [
      ["taker", usd(takerNotional), pct(totalNotional ? takerNotional / totalNotional : 0)],
      ["maker", usd(makerNotional), pct(totalNotional ? makerNotional / totalNotional : 0)],
    ],
    ["role", "notional", "share"],
  );
  console.log(
    `\naccounts: ${all.length}  |  pure-maker (≥95%): ${pureMakers}  ` +
      `pure-taker (≤5%): ${pureTakers}  mixed: ${mixed}`,
  );
}

async function pull(nord: Nord, market: string, sinceMs: number, out: TradeFromApi[]): Promise<number> {
  const marketId = symbolToId(market);
  // Pages return newest-first; stop once trades fall before the cutoff.
  let n = 0;
  for await (const t of iterateTrades(
    nord,
    { marketId, pageSize: 100 },
    (info) => { if (info.pages % 20 === 0) log.info("Fetching", { market, ...info }); },
  )) {
    if (Date.parse(t.time) < sinceMs) break;
    out.push(t);
    n++;
  }
  log.info("Fetched", { market, trades: n });
  return n;
}

async function main() {
  const args = parseArgs();
  const cfg = getConfig();
  const sinceMs = Date.now() - args.days * 86_400_000;

  log.info("Analyzing", {
    network: cfg.network, markets: args.markets, days: args.days,
    since: new Date(sinceMs).toISOString(),
  });

  const nord = await getNord();
  initMarkets(nord);

  // Pages arrive newest-first, but avg-cost PnL must process fills oldest-first,
  // so collect everything then replay in ascending trade-ID (chronological) order.
  const trades: TradeFromApi[] = [];
  let total = 0;
  for (const market of args.markets) total += await pull(nord, market, sinceMs, trades);
  trades.sort((a, b) => a.tradeId - b.tradeId);

  const reg = new TraderRegistry();
  for (const t of trades) reg.applyTrade(t);

  console.log(`\n=== Trader analysis: ${args.markets.join(",")} · last ${args.days}d · ${total} trades ===`);
  report(reg, args);
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  log.error("Fatal", { error: err.message, stack: err.stack });
  process.exit(1);
});
