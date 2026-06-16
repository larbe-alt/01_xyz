# NordUser — Authenticated Client

Represents a signed-in trading account. Required for all write operations.

## Initialization

```ts
// From private key (server / bot)
const user = NordUser.fromPrivateKey(nord, privateKey)  // sync, no await

// From Keypair (preferred for bots)
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
const user = await NordUser.fromKeypair(nord, keypair)

// From browser wallet (custom sign fns)
const user = await NordUser.new({
  nord,
  walletPubkey,
  sessionPubkey,       // ephemeral session key (Uint8Array)
  sessionId?,          // existing session — skip refreshSession() if provided
  signMessageFn,       // (utf8: Uint8Array) => Promise<Uint8Array>
  signTransactionFn,   // (tx: Transaction) => Promise<Transaction>
  signSessionFn,       // signs with sessionPubkey
})

// Always call after init:
await user.updateAccountId()
await user.fetchInfo()
```

> For Ledger: set `user.__use_solana_transaction_framing__ = true` (uses signTransaction instead of signMessage for session creation — brittle, avoid if possible).

---

## State Fields

After `fetchInfo()` these fields are populated:

```ts
user.accountIds   // number[]
user.balances     // { [symbol]: { accountId, balance, symbol }[] }
user.orders       // { [key]: { orderId, marketId, side, size, price, originalOrderSize, clientOrderId }[] }
user.positions    // { [key]: { marketId, openOrders, perp?: { baseSize, price, isLong, fundingPaymentPnl, sizePricePnl, updatedFundingRateIndex } }[] }
user.margins      // { [accountId]: { omf, mf, imf, cmf, mmf, pon, pn, bankruptcy } }
user.sessionId    // bigint | undefined
user.publicKey    // PublicKey
```

Margin fields: `omf` = open margin fraction, `mf` = margin fraction, `imf` = initial, `cmf` = cancel, `mmf` = maintenance, `pon`/`pn` = portfolio notional, `bankruptcy` = boolean flag.

---

## Orders

```ts
// Place order — returns fills immediately if matched
const result = await user.placeOrder({
  marketId: 0,
  side: Side.Bid | Side.Ask,
  fillMode: FillMode.Limit | FillMode.PostOnly | FillMode.ImmediateOrCancel | FillMode.FillOrKill,
  isReduceOnly: false,
  size?: Decimal.Value,       // base size
  quoteSize?: Decimal.Value,  // alternative: quote-denominated size
  price?: Decimal.Value,      // required for Limit / PostOnly
  accountId?: number,         // defaults to first account
  clientOrderId?: bigint,     // your own tracking id
  selfTradePrevention?: SelfTradePrevention,  // undocumented — prevents self-fill
})
// → { actionId, orderId?, fills: NormalizedReceiptTrade[], reducedOrders, selfTradeCancels }

// Cancel by exchange orderId
await user.cancelOrder(orderId, accountId?)
// → { actionId, orderId, accountId }

// Cancel by your clientOrderId (undocumented)
await user.cancelOrderByClientId(clientOrderId, accountId?)
// → { actionId, orderId, accountId }
```

### FillMode values

| Value | Behaviour |
|-------|-----------|
| `Limit` (0) | Resting limit order |
| `PostOnly` (1) | Rejected if it would immediately fill |
| `ImmediateOrCancel` (2) | Fill whatever matches, cancel the rest |
| `FillOrKill` (3) | Fill entirely or cancel — effectively a market order |

---

## Atomic Batch (undocumented)

Execute up to **10 subactions in a single engine action**. All succeed or all fail.

```ts
await user.atomic([
  { kind: "cancel",          orderId },
  { kind: "cancelByClientId", clientOrderId },
  { kind: "place",           marketId, side, fillMode, isReduceOnly, size?, price?, quoteSize?, clientOrderId? },
  { kind: "addTrigger",      marketId, side, triggerKind, triggerPrice, limitPrice?, limitBaseSize?, limitQuoteSize? },
  { kind: "editTrigger",     triggerId, marketId, side, triggerKind, triggerPrice, ... },
  { kind: "removeTrigger",   marketId, triggerId },
], accountId?)
// → { actionId, results: Receipt_AtomicSubactionResultKind[] }
```

**Phase ordering per market:** cancels → intermediate trades → placements. Across markets, any order is fine.

---

## Triggers (StopLoss / TakeProfit)

Up to **16 triggers per position**. If both size fields omitted, fires with max reduce size.

```ts
// Add
await user.addTrigger({
  marketId, side,
  kind: TriggerKind.StopLoss | TriggerKind.TakeProfit,
  triggerPrice,
  limitPrice?,      // limit price when trigger fires
  limitBaseSize?,   // base size limit
  limitQuoteSize?,  // quote size limit
  accountId?,
})
// → { actionId, triggerId }

// Edit
await user.editTrigger({ triggerId, marketId, side, kind, triggerPrice, limitPrice?, limitBaseSize?, limitQuoteSize?, accountId? })
// → { actionId }

// Remove
await user.removeTrigger({ marketId, triggerId, accountId? })
// → { actionId }
```

---

## Deposits & Withdrawals

```ts
// Deposit (new — preferred over deprecated depositSpl)
await user.deposit({ amount, tokenId, recipient?: PublicKey, sendOptions? })
// → { signature: string, buffer: PublicKey }
// buffer can be used to correlate the deposit in the queue

// Withdraw
await user.withdraw({ amount, tokenId, destPubkey?: string })
// → { actionId }
```

---

## Subaccounts & Transfers (undocumented)

```ts
// Transfer to own subaccount (omit toAccountId to create new subaccount)
await user.transferOwned({ tokenId, amount, fromAccountId, toAccountId? })
// → { actionId, newAccountId? }

// Transfer to any external account
await user.transferUnowned({ tokenId, amount, fromAccountId, toAccountId })
// → { actionId }
```

---

## On-chain Solana Balances (undocumented)

Reads SPL token balances from the Solana wallet directly (not the exchange).

```ts
await user.getSolanaBalances({
  includeZeroBalances?: boolean,   // default: true
  includeTokenAccounts?: boolean,  // default: false — also return ATA addresses
  maxConcurrent?: number,          // default: 5
  maxRetries?: number,             // default: 3
})
// → { balances: { [symbol]: number }, tokenAccounts?: { [symbol]: string } }
```

---

## Liquidation (undocumented)

Take all positions and balances from a bankrupt account. Returns what was taken.

```ts
await user.takePositions({ targetAccountId })
// → { actionId, takerAccountId, takenBalances: { tokenId, amount }[], takenPositions: { marketId, baseSize, settlementPrice, bankruptcyPrice }[] }
```

---

## Session Management

```ts
await user.refreshSession()           // get a new session from the server
await user.revokeSession(sessionId)   // invalidate a session
user.getNonce()                       // current action nonce (number)
```
