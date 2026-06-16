# Nord — Public Client

The `Nord` class is the unauthenticated entry point. No private key required.

## Initialization

```ts
const nord = await Nord.new({
  app: APP_KEY,
  solanaConnection: new Connection(RPC_URL),
  webServerUrl: WEB_SERVER_URL,
});
```

---

## Market Data

### Documented

```ts
nord.getOrderbook({ symbol?: string, marketId?: number })
nord.getTrades({ marketId?, takerId?, makerId?, takerSide?, pageSize?, since?, until?, startInclusive?, paginationMode? })
nord.getInfo()           // markets + tokens list
nord.getMarketStats({ marketId })
```

### Undocumented

```ts
// Real-time mark price, funding rate, open interest
nord.getMarketsLive()                    // → MarketsLiveInfo (all markets)
nord.getMarketLive({ marketId })         // → MarketLiveInfo  (single market)

// Oracle index price + metadata for a token
nord.getTokenStats(tokenId)              // → TokenStats

// OHLCV candles via WebSocket
nord.subscribeBars(symbol, resolution)   // resolution: "1"|"5"|"15"|"30"|"60"|"4H"|"1D"|"1W"|"1M"
```

---

## Account Queries (no auth needed)

```ts
// Resolve accountIds from a wallet pubkey
nord.getUser({ pubkey: string | PublicKey })     // → User | null

// Reverse: pubkey from accountId
nord.getAccountPubkey(accountId)                 // → string (base58)

// Open orders for any account
nord.getAccountOrders(accountId, { startInclusive?, pageSize? })

// Fee info
nord.getFeeBrackets()                            // → [FeeTierId, FeeTierConfig][] — maker/taker in ppm
nord.getAccountFeeTier(accountId)                // → FeeTierId
nord.getMarketFee({ marketId, feeKind, accountId }) // actual fee in quote units
nord.getAccountWithdrawalFee(accountId)          // withdrawal fee in quote units

// PnL
nord.getAccountPnl(accountId, { since?, until?, startInclusive?, pageSize? })
nord.getAccountPnlSummary(accountId, { since?, until?, marketId? })      // totals per market
nord.getAccountPositionHistory(accountId, { since?, until?, marketId?, pageSize?, startInclusive? })

// Volume (for fee tier tracking)
nord.getAccountVolume({ accountId, since, until, marketId? })  // → AccountVolumeInfo[]

// Triggers
nord.getAccountTriggers({ accountId? })
nord.getAccountTriggerPlaceHistory({ accountId?, since, until, pageSize?, startInclusive? })
nord.getAccountTriggerFinaliseHistory({ accountId?, since, until, pageSize?, startInclusive? })

// Withdrawals
nord.getAccountWithdrawalHistory({ accountId?, since, until, pageSize?, startInclusive? })

// Liquidations
nord.getTakeAlls()   // → TakeAllInfo[] recent liquidation rows
```

---

## Action Log

```ts
nord.getLastActionId()                       // latest action id from the engine
nord.queryAction({ actionId })               // → ActionResponse | null
nord.queryRecentActions({ from, to })        // → ActionResponse[]
nord.getActionNonce()                        // next expected nonce
nord.getTimestamp()                          // server timestamp as bigint
```

---

## Admin / ACL (read-only)

```ts
nord.getAdminList()   // → AdminInfo[] — list of privileged keys with their ACL role mask
```

---

## WebSocket

```ts
// Convenience subscriptions (create a managed WS client)
nord.createWebSocketClient({
  trades?: string[],       // e.g. ["BTCUSDC", "ETHUSDC"]
  deltas?: string[],       // orderbook delta streams
  accounts?: number[],     // account update streams
  candles?: Array<{ symbol: string; resolution: CandleResolution }>,
  liquidations?: boolean,  // take-all liquidation stream
})

// Individual subscriptions (return typed EventEmitter)
nord.subscribeOrderbook(symbol)             // → OrderbookSubscription
nord.subscribeTrades(symbol)               // → TradeSubscription
nord.subscribeBars(symbol, resolution)     // → CandleSubscription
nord.subscribeAccount(accountId)           // → UserSubscription
```

Subscription patterns: `trades@BTCUSDC`, `deltas@ETHUSDC`, `account@42`, `candle@BTCUSDC`

---

## Market IDs

| Symbol   | marketId |
|----------|----------|
| BTC-PERP | 0        |
| ETH-PERP | 1        |
| SOL-PERP | 2        |

Full list always available via `nord.markets` after init or `getInfo()`.
