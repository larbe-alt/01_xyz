import { getNord, getUser, getConfig, close } from "../client.js";
import { createLogger } from "../utils/logger.js";
import { getOffset } from "../utils/time.js";
import { initMarkets, bySymbol, byId, marketRoundPrice, marketRoundSize } from "../registry/markets.js";
import { initTokens, tokenById, tokenBySymbol } from "../registry/tokens.js";

const log = createLogger("smoke");

async function main() {
  const cfg = getConfig();
  log.info("Smoke test starting", { network: cfg.network });

  const nord = await getNord();

  // Server info
  const info = await nord.getInfo();
  log.info("Markets", { count: info.markets.length });
  for (const m of info.markets) {
    log.info(`  ${m.symbol}`, {
      marketId: m.marketId,
      priceDecimals: m.priceDecimals,
      sizeDecimals: m.sizeDecimals,
    });
  }

  log.info("Tokens", { count: info.tokens.length });
  for (const t of info.tokens) {
    log.info(`  ${t.symbol}`, { tokenId: t.tokenId, decimals: t.decimals });
  }

  // Live markets
  const live = await nord.getMarketsLive();
  for (const ml of live.markets) {
    log.info(`Market ${ml.marketId} live`, {
      markPrice: ml.perpetuals?.markPrice ?? null,
      fundingRate: ml.perpetuals?.projectedFundingRate ?? null,
      indexPrice: ml.indexPrice ?? null,
    });
  }

  // Orderbook sample (first market)
  if (info.markets.length > 0) {
    const sym = info.markets[0].symbol;
    const ob = await nord.getOrderbook({ symbol: sym });
    const bestBid = ob.bids?.[0];
    const bestAsk = ob.asks?.[0];
    log.info(`Orderbook ${sym}`, {
      bestBid: bestBid ? `${bestBid[0]} x ${bestBid[1]}` : "empty",
      bestAsk: bestAsk ? `${bestAsk[0]} x ${bestAsk[1]}` : "empty",
      bidDepth: ob.bids?.length ?? 0,
      askDepth: ob.asks?.length ?? 0,
    });
  }

  // Registry
  await initMarkets(nord);
  await initTokens(nord);

  const btc = bySymbol("BTCUSD");
  log.info("Registry lookup BTCUSD", { ...btc });
  const btcBack = byId(btc.marketId);
  log.info("Registry roundtrip byId", { matches: btcBack.symbol === "BTCUSD" });

  const roundedPrice = marketRoundPrice("BTCUSD", "65432.789");
  const roundedSize = marketRoundSize("BTCUSD", "0.123456789");
  log.info("Rounding BTCUSD", {
    rawPrice: "65432.789",
    rounded: roundedPrice.toString(),
    rawSize: "0.123456789",
    roundedSize: roundedSize.toString(),
  });

  const usdc = tokenBySymbol("USDC");
  log.info("Token USDC", { ...usdc });
  const usdcBack = tokenById(usdc.tokenId);
  log.info("Token roundtrip", { matches: usdcBack.symbol === "USDC" });

  // Time sync
  log.info("Time sync", { offsetMs: getOffset() });

  // User account (if private key set)
  if (cfg.privateKey) {
    const user = await getUser();
    log.info("Account IDs", { ids: user.accountIds });

    log.info("Balances", { balances: user.balances });

    const positionCount = Object.values(user.positions).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    log.info("Positions", { count: positionCount, positions: user.positions });

    log.info("Margins", { margins: user.margins });

    const orderCount = Object.values(user.orders).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    log.info("Open orders", { count: orderCount });
  } else {
    log.warn("PRIVATE_KEY not set — skipping user account checks");
  }

  await close();
  log.info("Smoke test complete");
}

main().catch((err) => {
  log.error("Smoke test failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
