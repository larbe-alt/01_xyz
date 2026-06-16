import { getNord, getUser, close } from "../client.js";
import { initMarkets, initTokens, bySymbol } from "../index.js";
import { WriteQueue } from "../core/queue.js";
import { AccountState } from "../core/account.js";
import { OrderManager } from "../core/orders.js";
import { PositionManager } from "../core/positions.js";
import { BalanceManager } from "../core/balances.js";
import { AtomicBuilder } from "../core/batch.js";
import { createLogger } from "../utils/logger.js";
import { Side, FillMode } from "@n1xyz/nord-ts";
import { Decimal } from "../utils/decimal.js";

const log = createLogger("test-core");

const MARKET = process.env.TEST_MARKET ?? "BTCUSD";

async function main() {
  log.info("=== Phase 2 Core Modules Integration Test ===");
  log.info(`Market: ${MARKET}`);

  // --- Init ---
  const nord = await getNord();
  const user = await getUser();
  await initMarkets(nord);
  await initTokens(nord);

  const queue = new WriteQueue();
  const account = new AccountState(nord, user, queue);
  const orders = new OrderManager(nord, user, queue, account);
  const positions = new PositionManager(nord, user, queue, account);
  const balances = new BalanceManager(nord, user, queue, account);

  // --- 1. Account State ---
  log.info("\n--- 1. Account State ---");
  await account.refresh();
  log.info("Account ID", { id: account.accountId });
  log.info("Equity", { equity: account.equity().toString() });
  log.info("Margin usage", { usage: account.marginUsage().toString() });
  log.info("Cross margin ratio", { ratio: account.crossMarginRatio().toString() });
  log.info("Bankrupt?", { bankrupt: account.isBankrupt() });
  log.info("State age", { ageMs: account.ageMs() });

  // --- 2. Balances ---
  log.info("\n--- 2. Balances ---");
  const exBalances = balances.exchange();
  for (const b of exBalances) {
    log.info(`  ${b.symbol}: ${b.balance.toString()}`);
  }
  const onchain = await balances.onchain();
  log.info("On-chain balances", onchain.balances);

  // --- 3. Existing Positions ---
  log.info("\n--- 3. Positions ---");
  const pos = positions.list();
  if (pos.length === 0) {
    log.info("No open positions");
  } else {
    for (const p of pos) {
      log.info(`  ${p.symbol}: ${p.isLong ? "LONG" : "SHORT"} ${p.baseSize} @ ${p.entryPrice} | pnl=${p.unrealizedPnl}`);
    }
  }

  // --- 4. Existing Orders ---
  log.info("\n--- 4. Open Orders ---");
  const openOrders = orders.open();
  log.info(`Open orders: ${openOrders.length}`);
  for (const o of openOrders) {
    log.info(`  ${o.symbol} ${o.side} ${o.size} @ ${o.price} (id=${o.orderId})`);
  }

  // --- 5. Place a limit order far from market ---
  log.info("\n--- 5. Place Limit Order ---");
  const meta = bySymbol(MARKET);
  const marketLive = await nord.getMarketLive({ marketId: meta.marketId });
  const indexPrice = marketLive.indexPrice;
  if (!indexPrice) {
    log.error("No index price available, cannot test order placement");
    await close();
    return;
  }

  // Place bid 5% below index to avoid fill but stay within exchange price bands
  const safePrice = new Decimal(indexPrice).mul(0.95).toDecimalPlaces(meta.priceDecimals);
  const minSize = new Decimal(1).div(new Decimal(10).pow(meta.sizeDecimals));

  log.info(`Index price: ${indexPrice}, safe bid price: ${safePrice}, min size: ${minSize}`);

  const placeResult = await orders.place({
    symbol: MARKET,
    side: Side.Bid,
    type: "limit",
    price: safePrice,
    size: minSize,
  });
  log.info("Place result", {
    actionId: placeResult.actionId.toString(),
    orderId: placeResult.orderId?.toString(),
    fills: placeResult.fills.length,
    cid: placeResult.clientOrderId.toString(),
  });

  // --- 6. Query the order ---
  log.info("\n--- 6. Query Order ---");
  await account.refresh();
  const afterPlace = orders.open(MARKET);
  log.info(`Open orders on ${MARKET}: ${afterPlace.length}`);
  for (const o of afterPlace) {
    log.info(`  ${o.side} ${o.size} @ ${o.price} (id=${o.orderId}, cid=${o.clientOrderId})`);
  }

  // --- 7. Edit the order (atomic cancel+place) ---
  if (placeResult.orderId) {
    log.info("\n--- 7. Edit Order ---");
    const newPrice = new Decimal(indexPrice).mul(0.94).toDecimalPlaces(meta.priceDecimals);
    const editResult = await orders.edit(placeResult.orderId, {
      symbol: MARKET,
      side: Side.Bid,
      price: newPrice,
      size: minSize,
    });
    log.info("Edit result", {
      actionId: editResult.actionId.toString(),
      newCid: editResult.clientOrderId.toString(),
    });

    await account.refresh();
    const afterEdit = orders.open(MARKET);
    log.info(`After edit, open orders on ${MARKET}: ${afterEdit.length}`);
    for (const o of afterEdit) {
      log.info(`  ${o.side} ${o.size} @ ${o.price} (id=${o.orderId})`);
    }
  }

  // --- 8. Cancel all ---
  log.info("\n--- 8. Cancel All ---");
  await orders.cancelAll(MARKET);
  await account.refresh();
  const afterCancel = orders.open(MARKET);
  log.info(`After cancelAll, open orders on ${MARKET}: ${afterCancel.length}`);

  // --- 9. Test AtomicBuilder standalone (two markets to avoid same-market phase conflict) ---
  log.info("\n--- 9. AtomicBuilder ---");
  const MARKET2 = "ETHUSD";
  const meta2 = bySymbol(MARKET2);
  const market2Live = await nord.getMarketLive({ marketId: meta2.marketId });
  const safePrice2 = new Decimal(market2Live.indexPrice ?? 0).mul(0.95).toDecimalPlaces(meta2.priceDecimals);
  const minSize2 = new Decimal(1).div(new Decimal(10).pow(meta2.sizeDecimals));

  const builder = new AtomicBuilder()
    .place({
      symbol: MARKET,
      side: Side.Bid,
      fillMode: FillMode.Limit,
      price: safePrice,
      size: minSize,
    })
    .place({
      symbol: MARKET2,
      side: Side.Bid,
      fillMode: FillMode.Limit,
      price: safePrice2,
      size: minSize2,
    });

  log.info(`Atomic batch: ${builder.count} subactions`);
  const atomicResult = await builder.submit(user, queue);
  log.info("Atomic result", { actionId: atomicResult.actionId.toString() });

  await account.refresh();
  const afterAtomic = orders.open(MARKET);
  log.info(`After atomic, open orders on ${MARKET}: ${afterAtomic.length}`);
  for (const o of afterAtomic) {
    log.info(`  ${o.side} ${o.size} @ ${o.price} (id=${o.orderId})`);
  }

  // Cleanup: cancel all orders across both markets
  await orders.cancelAll(MARKET);
  await orders.cancelAll(MARKET2);
  await account.refresh();
  log.info(`Final cleanup: ${orders.open().length} orders remaining`);

  // --- 10. Position liq price (if any position exists) ---
  log.info("\n--- 10. Position Analysis ---");
  const currentPos = positions.list();
  if (currentPos.length > 0) {
    const p = currentPos[0];
    const liqPrice = await positions.liquidationPrice(p.symbol);
    log.info(`${p.symbol} liq price: ${liqPrice?.toString() ?? "N/A"}`);
    const pnlEst = await positions.closePnlEstimate(p.symbol);
    if (pnlEst) {
      log.info(`Close PnL estimate: ${pnlEst.estimatePnl.toString()}, avg exit: ${pnlEst.avgExitPrice?.toString()}, filled: ${pnlEst.fullyFilled}`);
    }
  } else {
    log.info("No positions to analyze");
  }

  // --- 11. Queue drain ---
  log.info("\n--- 11. Queue ---");
  await queue.drain();
  log.info(`Queue depth: ${queue.depth}`);

  log.info("\n=== All Phase 2 tests passed ===");
  await close();
}

main().catch((err) => {
  log.error("Test failed", { error: err instanceof Error ? err.message : String(err), stack: (err as Error).stack });
  process.exit(1);
});
