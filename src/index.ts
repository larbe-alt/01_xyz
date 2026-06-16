export { getNord, getUser, close, getConfig } from "./client.js";
export { loadConfig } from "./config.js";
export type { Config, Network } from "./config.js";
export { createLogger } from "./utils/logger.js";
export type { Logger, LogLevel } from "./utils/logger.js";
export { roundPrice, roundSize, isZero, abs, fmt, Decimal } from "./utils/decimal.js";
export { retry } from "./utils/retry.js";
export type { RetryOpts } from "./utils/retry.js";
export { syncTime, serverNow, getOffset } from "./utils/time.js";
export { initMarkets, refreshMarkets, allMarkets, bySymbol, byId, marketRoundPrice, marketRoundSize, symbolToId, idToSymbol } from "./registry/markets.js";
export type { MarketMeta } from "./registry/markets.js";
export { initTokens, refreshTokens, allTokens, tokenBySymbol, tokenById, tokenIdToSymbol, tokenSymbolToId } from "./registry/tokens.js";
export type { TokenMeta } from "./registry/tokens.js";

// Core modules (Phase 2)
export { classifyError, isRetryable } from "./core/errors.js";
export type { ErrorKind, ClassifiedError } from "./core/errors.js";
export { WriteQueue } from "./core/queue.js";
export { AtomicBuilder } from "./core/batch.js";
export { AccountState } from "./core/account.js";
export { OrderManager } from "./core/orders.js";
export type { PlaceIntent, NormalizedOrder, PlaceResult } from "./core/orders.js";
export { PositionManager } from "./core/positions.js";
export type { Position } from "./core/positions.js";
export { BalanceManager } from "./core/balances.js";
export type { TokenBalance } from "./core/balances.js";

// Data modules (Phase 3)
export { LiveFeed } from "./data/feed.js";
export type { FeedOptions, LocalBook } from "./data/feed.js";
