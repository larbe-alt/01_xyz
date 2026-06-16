import "../utils/polyfills.js";
import { getNord, getConfig } from "../client.js";
import { initMarkets, byId } from "../registry/markets.js";
import { initTokens } from "../registry/tokens.js";
import { LiveFeed } from "../data/feed.js";
import { createLogger } from "../utils/logger.js";
import type {
  WebSocketTradeUpdate,
  WebSocketDeltaUpdate,
  WebSocketCandleUpdate,
} from "@n1xyz/nord-ts";

const log = createLogger("test-feed");

const SYMBOL = process.argv[2] || "BTCUSD";
const DURATION_S = Number(process.argv[3] || 60);

async function main() {
  const cfg = getConfig();
  log.info("Starting feed test", { network: cfg.network, symbol: SYMBOL, durationS: DURATION_S });

  const nord = await getNord();
  await initMarkets(nord);
  await initTokens(nord);

  const feed = new LiveFeed(nord, {
    trades: [SYMBOL],
    deltas: [SYMBOL],
    candles: [{ symbol: SYMBOL, resolution: "1" }],
  });

  let tradeCount = 0;
  let deltaCount = 0;
  let candleCount = 0;
  let bookUpdates = 0;

  feed.on("connected", () => log.info("Feed connected"));
  feed.on("disconnected", () => log.warn("Feed disconnected"));
  feed.on("reconnecting", (attempt) => log.info("Reconnecting", { attempt }));
  feed.on("error", (err) => log.error("Feed error", { error: err.message }));

  feed.on("trade", (update: WebSocketTradeUpdate) => {
    tradeCount++;
    for (const t of update.trades) {
      log.info("Trade", {
        symbol: update.market_symbol,
        side: t.side,
        price: t.price,
        size: t.size,
      });
    }
  });

  feed.on("delta", (_update: WebSocketDeltaUpdate) => {
    deltaCount++;
  });

  feed.on("candle", (update: WebSocketCandleUpdate) => {
    candleCount++;
    log.info("Candle", {
      res: update.res,
      o: update.o,
      h: update.h,
      l: update.l,
      c: update.c,
      v: update.v,
    });
  });

  feed.on("book", (symbol: string) => {
    bookUpdates++;
    if (bookUpdates % 50 === 1) {
      const mid = feed.getMid(symbol);
      const spread = feed.getSpread(symbol);
      const bids = feed.getBids(symbol, 3);
      const asks = feed.getAsks(symbol, 3);
      log.info("Book snapshot", {
        symbol,
        mid: mid?.toFixed(2),
        spread: spread?.toFixed(4),
        bestBid: bids[0],
        bestAsk: asks[0],
        bidLevels: feed.getBook(symbol)?.bids.size,
        askLevels: feed.getBook(symbol)?.asks.size,
      });
    }
  });

  feed.start();

  const statsInterval = setInterval(() => {
    log.info("Stats", {
      trades: tradeCount,
      deltas: deltaCount,
      candles: candleCount,
      bookUpdates,
      bookSynced: feed.getBook(SYMBOL) != null,
    });
  }, 10_000);

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), DURATION_S * 1_000);

    process.on("SIGINT", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  clearInterval(statsInterval);
  feed.close();

  log.info("Test complete", {
    trades: tradeCount,
    deltas: deltaCount,
    candles: candleCount,
    bookUpdates,
  });
}

main().catch((err) => {
  log.error("Fatal", { error: err.message, stack: err.stack });
  process.exit(1);
});
