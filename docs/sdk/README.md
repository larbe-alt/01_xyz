# Nord SDK Reference

Internal reference derived from the `@n1xyz/nord-ts` type declarations. Covers both documented and undocumented API surface.

## Files

- [nord-public-client.md](./nord-public-client.md) — `Nord` class: market data, account queries, action log, WebSocket
- [nord-user.md](./nord-user.md) — `NordUser` class: orders, atomic batch, triggers, transfers, deposits/withdrawals
- [nord-admin.md](./nord-admin.md) — `NordAdmin` class: markets, tokens, fee tiers, ACL, oracle (operator-only)

---

## Undocumented Features — Bot Priority

### Critical — bot is incomplete without these

| Feature | Why it matters |
|---------|---------------|
| `atomic(userActions[])` | Replace multiple round-trips with one engine action. Cancel old limit + place new one atomically — no gap where another order can slip in. Essential for market-making and rebid/reoffer strategies. |
| `cancelOrderByClientId()` | Assign your own `clientOrderId` at placement, cancel without storing the exchange's `orderId`. Simplifies state management — no need to parse responses and maintain a mapping. |
| `SelfTradePrevention` on `placeOrder` | Prevents bot from accidentally trading against itself (two subaccounts, fast rebid). Without it: double commission + fake volume. Enforced at engine level. |
| `getMarketsLive()` / `getMarketLive()` | Real-time mark price + funding rate. Without this a bot on perps doesn't know the cost of holding a position. Baseline data for any perpetual strategy. |
| `deposit()` (new, returns `buffer`) | `buffer` is a queue correlation ID — lets bot track whether a deposit landed on the exchange, not just on-chain. Old `depositSpl` is deprecated and doesn't provide this. |

### Important — needed in production

| Feature | Why it matters |
|---------|---------------|
| `editTrigger()` | Modify SL/TP without remove + add. Saves a transaction and eliminates the unprotected window between deleting and creating a new trigger. |
| `getAccountTriggerPlaceHistory()` / `getAccountTriggerFinaliseHistory()` | Which trigger fired, at what price, stop or take? Required to reconstruct state after a bot restart. |
| `queryAction()` / `queryRecentActions()` | Engine audit log. Lets bot recover state by replaying events when it comes back online after a WS disconnect — not just from a snapshot. |
| `getSolanaBalances()` | Check on-chain wallet balance before a deposit. Prevents attempting to deposit more than the wallet holds. |
| `getAccountPnlSummary()` | Aggregated P&L per market over a time window. Used for reporting, dynamic position sizing based on historical returns, or halting on drawdown limit. |
| `transferOwned()` | Create a subaccount and fund it in one call. Enables isolated margin per strategy: one subaccount = one strategy, risks don't mix. |

### Strategy-specific

| Feature | Why it matters |
|---------|---------------|
| `takePositions({ targetAccountId })` | Liquidator role: watch `user.margins[id].bankruptcy`, call `takePositions` when `true`. Profitable if position is taken below bankruptcy price. A separate strategy in itself. |
| `subscribeBars()` (OHLCV candles) | Ready-made candles from the exchange, no need to aggregate from trades. Used for TA-based strategies or signal generation. |
| `getTokenStats()` | Oracle index price. Difference between mark price and index price is the basis — core input for basis trading and evaluating whether funding rate is justified. |
| `getAccountVolume()` | Trading volume over a time window. Used when bot manages its own fee tier (high volume → right to request lower fees from operator) or for internal analytics. |

### Operational

| Feature | Why it matters |
|---------|---------------|
| `getAccountWithdrawalHistory()` | Reconciliation: compare on-chain withdrawals with exchange-side debits. Prevents silent fund loss on failure. |
| `getAccountOrders(accountId)` via `Nord` (no auth) | One bot can inspect orders of another subaccount without holding its private key in memory. Useful for a separate monitoring service. |
| `transferUnowned()` | Transfer collateral to an external account (e.g. a partner). Rare for a bot, but needed for operational flows. |

---

## Enums Quick Reference

```ts
Side             { Bid = "bid", Ask = "ask" }
FillMode         { Limit=0, PostOnly=1, ImmediateOrCancel=2, FillOrKill=3 }
TriggerKind      { StopLoss=0, TakeProfit=1 }
TriggerStatus    { Active=0, Success=1, Cancel=2, Remove=4 }
CandleResolution "1" | "5" | "15" | "30" | "60" | "4H" | "1D" | "1W" | "1M"
AclRole          { FEE_MANAGER=1, MARKET_MANAGER=2, ADMIN=2147483648 }
```
