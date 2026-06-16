# NordAdmin — Privileged Exchange Operator Client

Not mentioned in the public docs. Used by the exchange operator to manage markets, tokens, fees, and ACL.

## Initialization

```ts
const admin = await NordAdmin.new({
  nord,
  admin: adminPublicKey,              // PublicKey of the privileged wallet
  signFn: (tx) => wallet.signTransaction(tx),
})
```

Requires the signing wallet to have an ACL role assigned on-chain.

---

## ACL Roles

```ts
enum AclRole {
  FEE_MANAGER   = 1,
  MARKET_MANAGER = 2,
  ADMIN          = 2147483648,
}

// Grant / revoke roles
await admin.updateAcl({ target: PublicKey, addRoles: AclRole[], removeRoles: AclRole[] })
// Removing all roles deletes the entry from ACL
```

---

## Market Management

```ts
// Create a new perpetual or spot market
await admin.createMarket({
  sizeDecimals,     // contract size tick
  priceDecimals,    // price tick
  imfBps,           // initial margin fraction in bps
  cmfBps,           // cancel margin fraction in bps
  mmfBps,           // maintenance margin fraction in bps
  marketType,       // proto.MarketType (Spot | Perpetual)
  viewSymbol,       // e.g. "BTCUSDC"
  oracleSymbol,     // resolved by oracle adapter
  baseTokenId,      // registered token id
})
// → { actionId } & Receipt_InsertMarketResult

await admin.freezeMarket({ marketId })    // halt trading
await admin.unfreezeMarket({ marketId })  // resume trading

// Global trading halt
await admin.pause()
await admin.unpause()
```

---

## Token Management

```ts
await admin.createToken({
  tokenDecimals,   // decimal shift for deposits/withdrawals
  weightBps,       // risk weight in bps for account value calculations
  viewSymbol,      // e.g. "USDC"
  oracleSymbol,
  mintAddr,        // Solana mint PublicKey
})
// → { actionId } & Receipt_InsertTokenResult
```

---

## Fee Tiers

Fee granularity is **ppm** (parts per million):

| ppm | percent |
|-----|---------|
| 1   | 0.0001% |
| 100 | 0.01%   |
| 500 | 0.05%   |
| 1000| 0.10%   |
| 5000| 0.50%   |

```ts
// Append a new tier (ids 0–15 max; tier 0 = default)
await admin.addFeeTier({ config: FeeTierConfig })
// → { actionId } & Receipt_FeeTierAdded

// Update existing tier
await admin.updateFeeTier({ tierId, config: FeeTierConfig })

// Assign tier to accounts
await admin.updateAccountsTier([accountId1, accountId2], tierId)

// Move funds from fee vault to an account
await admin.feeVaultTransfer({ recipient: accountId, tokenId, amount })
```

---

## Backstop & Liquidations

```ts
// Set the backstop account that absorbs liquidated positions
await admin.setBackstopAccount({ accountId })
```

---

## Oracle (Pyth)

```ts
// Map an oracle symbol to a Pyth price feed
await admin.pythSetSymbolFeed({ oracleSymbol, priceFeedId })  // priceFeedId: 32-byte hex

// Update Wormhole guardian set for Pyth price verification
await admin.pythSetWormholeGuardians({ guardianSetIndex, addresses })  // addresses: 20-byte hex[]
```
