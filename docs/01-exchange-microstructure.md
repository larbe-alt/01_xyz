# 01 Exchange — Microstructure Reference

*Source: official docs (docs.01.xyz, docs.n1.xyz), Nord SDK type declarations, REST API spec.*

---

## 1. Stack

```
Solana (on-chain custody — deposits / withdrawals)
    ↓
N1 Blockchain — L1 purpose-built for finance
    ↓
NordVM — proprietary execution rollup (orderbook engine)
    ↓
01 Exchange (perpetuals DEX)
```

**N1 is L1, not L2.** Architecture: lean settlement layer + asynchronous execution network.
NordVM is an isolated process with its own VM; it communicates with the settlement layer via ordered channels.
ZK/proof details are not publicly disclosed.

---

## 2. Order Lifecycle

```
Client SDK
  │
  ├─ 1. Sign action (Ed25519 session key)
  │       CreateSession first → receive sessionId
  │       All trading actions signed with the session key
  │
  ├─ 2. HTTP POST → zo-mainnet.n1.xyz
  │       Body: protobuf action (placeOrder / cancelOrder / atomic)
  │       Returns: Receipt { actionId, orderId?, fills[], errors }
  │
  ├─ 3. NordVM Engine Processing
  │       Nonce check          (replay protection)
  │       Pre-trade margin check
  │       Matching engine      (price-time priority CLOB)
  │       State update         (positions, balances, open orders)
  │
  ├─ 4. Fill response — synchronous in the same HTTP response
  │       fills: NormalizedReceiptTrade[]
  │       reducedOrders, selfTradeCancels
  │
  └─ 5. WebSocket push (account subscription)
          account@{accountId} stream — mirrors fills + position updates
```

**Fills are returned synchronously** in the `placeOrder` response — no need to wait for WS.
WebSocket is only needed for streaming updates triggered by other participants.

---

## 3. Atomic Batch

Up to **10 subactions in a single engine action**. Execution order within one market:

```
cancels → intermediate trades → placements
```

Across markets: any order. All subactions are **all-or-nothing** — if one fails, all are rolled back.

Critical for market-making: cancel + place is atomic, no window where the book is unprotected.

```ts
await user.atomic([
  { kind: "cancelByClientId", clientOrderId },
  { kind: "place", marketId, side, fillMode, size, price, clientOrderId },
], accountId)
// → { actionId, results: Receipt_AtomicSubactionResultKind[] }
```

---

## 4. Margin System

Each account exposes 5 margin fractions:

| Field | Meaning |
|-------|---------|
| `imf` | Initial margin fraction — required to open a position |
| `cmf` | Cancel margin fraction — below this, exchange may cancel resting orders |
| `mmf` | Maintenance margin fraction — below this, liquidation triggered |
| `mf`  | Current margin fraction = equity / notional |
| `omf` | Open margin fraction (includes open order exposure) |

Invariant: `imf > cmf > mmf`

Parameters are set per-market in `createMarket` (in bps). Tokens carry a `weightBps` risk weight used in account value calculations.

**Liquidation flow:**
1. `margins[accountId].bankruptcy` flips to `true`
2. Any account can call `user.takePositions({ targetAccountId })`
3. Taker receives positions + balances at bankruptcy price (profitable if below)
4. A backstop account (operator-set) absorbs positions that remain unliquidated

---

## 5. Auth / Session Model

```
Wallet pubkey (Solana keypair) — master key
    ↓
CreateSession → sessionId (bigint) + ephemeral session keypair
    ↓
All orders signed with the session key (fast, Ledger not required)
    ↓
Session revocable: user.revokeSession(sessionId)
```

Each action carries a **nonce** for replay protection.
`getActionNonce()` returns the next expected nonce.

---

## 6. Data Model

```
Account → accountIds[]  (subaccounts for isolated margin)
  ├─ balances[symbol][]     — collateral
  ├─ orders[key][]          — open orders { orderId, marketId, side, size, price, clientOrderId }
  ├─ positions[key][]       — perp positions
  │     { baseSize, price, isLong, fundingPaymentPnl, sizePricePnl, updatedFundingRateIndex }
  ├─ margins[accountId]     — MF fields + bankruptcy flag
  └─ triggers[]             — SL/TP (up to 16 per position)
```

---

## 7. Oracle / Mark Price

- Oracle: **Pyth** (configured via `pythSetSymbolFeed` — 32-byte priceFeedId, Wormhole guardian set)
- `getTokenStats(tokenId)` → index price
- `getMarketLive({ marketId })` → mark price + funding rate + open interest
- **Basis** = mark − index → key input for funding arbitrage and carry signals

---

## 8. Fees

Granularity: **ppm** (parts per million). Up to 16 tiers (tier 0 = default).

| ppm  | percent |
|------|---------|
| 100  | 0.01%   |
| 500  | 0.05%   |
| 1000 | 0.10%   |

Tiers are assigned per-account by the operator. Volume tracked via `getAccountVolume()`.

---

## 9. State Recovery After Disconnect

```ts
// Replay events from last known actionId
nord.queryRecentActions({ from, to })   // → ActionResponse[]
nord.queryAction({ actionId })

// Which SL/TP fired
nord.getAccountTriggerFinaliseHistory({ accountId, since, until })
```

This is the primary recovery mechanism after a WebSocket drop — **event replay, not snapshot**.

---

## 10. Deposit Flow (Solana → Exchange)

```ts
await user.deposit({ amount, tokenId })
// → { signature: string, buffer: PublicKey }
```

`buffer` is a queue correlation ID that tracks whether the deposit landed on the exchange side (not just on-chain). `depositSpl` is deprecated — use `deposit()` only.

---

## 11. Order Types

| FillMode          | Behaviour |
|-------------------|-----------|
| `Limit` (0)       | Resting limit order |
| `PostOnly` (1)    | Rejected if it would immediately cross |
| `ImmediateOrCancel` (2) | Fill what matches, cancel the rest |
| `FillOrKill` (3)  | Fill entirely or cancel — equivalent to market order |

---

## 12. Key Latency Notes

- Fills are **synchronous** in the HTTP response (no polling needed)
- WS streams: `trades@SYMBOL`, `deltas@SYMBOL`, `account@ID`, `candle@SYMBOL`
- Binance leads 01 by ~100ms on ETH and HYPE price moves (measured 2026-06-20, corr ~0.40 ETH / 0.33 HYPE) — see `docs/binance-crossvenue-plan.md`

---

**Summary:** 01 delivers CEX-grade execution (synchronous fills, atomic batches, session keys) with non-custodial settlement via Solana. NordVM is a proprietary orderbook rollup on top of N1 L1. Matching engine internals and proof details are not publicly disclosed.
