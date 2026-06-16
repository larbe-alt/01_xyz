# Research Pipeline — Quant-ML for 01 Exchange

Strategy-agnostic ML pipeline. You train models in Python, export them as JSON,
and any TypeScript strategy loads + calls `predict()` with zero Python dependency
at runtime.

```
Parquet data ──→ Python: features + labels ──→ Train (LightGBM) ──→ model.json
                                                                        ↓
                                                        TS: FeatureState + GBDTModel
                                                                        ↓
                                                        strategy.onBook → predict() → trade
```

---

## Quick start

### 1. Install Python deps

```bash
cd research
uv venv .venv --python 3.12
uv pip install polars duckdb lightgbm numpy pytest --python .venv/bin/python
source .venv/bin/activate
```

### 2. Build a dataset

```bash
python -m scripts.build_dataset --symbol ETHUSD --env mainnet --sample-ms 1000
```

This reads the recorded parquet data (`data/mainnet/{snapshot,delta,trade}/ETHUSD/`),
reconstructs the L2 book at every event, computes 15 features at 1-second intervals,
adds forward-return labels, and writes `research/datasets/ETHUSD.parquet`.

Options:
- `--dir data` — path to data directory (default: `data`)
- `--sample-ms 500` — feature sample interval (lower = more rows, higher resolution)
- `--from-ts 1700000000000` / `--to-ts ...` — filter time range (ms)
- `--out path.parquet` — custom output path

### 3. Train a model

```bash
python -m scripts.train_model --dataset datasets/ETHUSD.parquet
```

Trains a LightGBM classifier on `fwd_return_sign_5s` (predict whether mid goes up
in next 5 seconds), exports to `research/artifacts/fwd_return_sign_5s.json`.

Options:
- `--label fwd_return_5s` — predict a different label
- `--objective regression` — regression instead of classification
- `--n-estimators 300` — more boosting rounds
- `--lr 0.03` — learning rate
- `--test-fraction 0.2` — test set size
- `--purge-ms 60000` — gap between train/test to prevent label leakage
- `--out path.json` — custom output path

Output:
```
── Train metrics ──
  accuracy: 0.523000
  logloss: 0.691200

── Test metrics ──
  accuracy: 0.511000
  logloss: 0.693000

── Feature importance ──
  book_imbalance_1          0.182  #########
  trade_imbalance_60s       0.145  #######
  spread_bps                0.121  ######
  ...

Model exported to research/artifacts/fwd_return_sign_5s.json
```

### 4. Use the model in a strategy (TypeScript)

```typescript
import { FeatureState, loadModel } from "../research/inference/index.js";
import type { Strategy, StrategyContext, FeedTrade } from "../engine/types.js";
import type { LocalBook } from "../data/feed.js";

export function myStrategy(): Strategy {
  const state = new FeatureState();
  const model = loadModel("research/artifacts/fwd_return_sign_5s.json");

  return {
    name: "my-strategy",
    async init() {},

    onTrade(t: FeedTrade, ctx: StrategyContext) {
      state.addTrade({ ts: t.ts, side: t.side, price: t.price, size: t.size });
      const mid = ctx.feed.getMid(t.symbol);
      if (mid) state.addMid(t.ts, mid);
    },

    onBook(book: LocalBook, ctx: StrategyContext) {
      state.prune(ctx.clock.now());
      const feats = state.compute(book, ctx.clock.now());
      const prob = model.predict(state.toArray(feats));

      // prob > 0.5 = model thinks price goes up
      // Use it however you want — this is YOUR strategy logic
    },
  };
}
```

That's it. Same code runs in live trading and in backtest — the `FeatureState`
only needs a `LocalBook` and timestamps, which both modes provide.

### 5. Validate with backtest

```bash
npm run backtest -- --config my-config.json
```

The backtester runs the strategy against recorded data with real fills, fees,
and slippage. The model's value is measured by PnL, not offline accuracy.

---

## Features (15 total)

All defined in `research/spec/features.json`. Python and TS compute identical
values (verified by the parity test).

### Microstructure (from L2 book)

| Feature | Description |
|---------|-------------|
| `spread_bps` | Bid-ask spread in basis points |
| `microprice` | Size-weighted mid: `(bid×askQty + ask×bidQty) / total` |
| `book_imbalance_1` | `(bidQty - askQty) / total` at top 1 level |
| `book_imbalance_5` | Same, top 5 levels |
| `depth_bid_5` | Cumulative bid size, 5 levels |
| `depth_ask_5` | Cumulative ask size, 5 levels |
| `depth_ratio_5` | `depth_bid_5 / depth_ask_5` |
| `wap_distance_bps` | VWAP spread of top-5 depth in bps |

### Trade flow (rolling 60s window)

| Feature | Description |
|---------|-------------|
| `trade_imbalance_60s` | `(buyVol - sellVol) / total` |
| `trade_intensity_60s` | Trades per second |
| `avg_trade_size_60s` | Mean trade size |
| `ofi_60s` | Net signed volume / total volume |

### Volatility (rolling window)

| Feature | Description |
|---------|-------------|
| `realized_vol_300s` | Annualized realized vol from mid returns (5min) |
| `return_10s` | Log return of mid over 10s |
| `return_60s` | Log return of mid over 60s |

---

## Labels (training only)

| Label | Description |
|-------|-------------|
| `fwd_return_1s` | Mid-price return over next 1 second |
| `fwd_return_5s` | Mid-price return over next 5 seconds |
| `fwd_return_30s` | Mid-price return over next 30 seconds |
| `fwd_return_sign_5s` | 1 if 5s return > 0, else 0 (classification) |

---

## Model format

Models are exported as JSON with a flat node-array tree structure. No ONNX,
no native deps — the TS evaluator walks the array directly.

```json
{
  "version": 1,
  "model_type": "gbdt",
  "feature_names": ["spread_bps", "microprice", ...],
  "trees": [
    {
      "nodes": [
        { "f": 0, "t": 3.5, "l": 1, "r": 2 },
        { "v": 0.1 },
        { "v": -0.05 }
      ]
    }
  ]
}
```

Node types:
- **Split**: `{ f: feature_index, t: threshold, l: left_child, r: right_child }`
  — go left if `feature[f] <= t`, else right
- **Leaf**: `{ v: value }` — return this value

Prediction = sum of leaf values across all trees. For classification, apply
sigmoid to get probability.

---

## TS API reference

### `FeatureState`

Maintains rolling buffers of trades and mids. Call from strategy hooks.

```typescript
const state = new FeatureState(maxWindowMs?: number);  // default 300_000 (5min)

state.addTrade({ ts, side, price, size });  // call in onTrade
state.addMid(ts, midValue);                 // call when mid changes
state.prune(now);                           // drop old entries (call periodically)

const feats: FeatureVector = state.compute(book, now);  // compute all 15 features
const arr: number[] = state.toArray(feats);              // ordered array for model.predict()
```

### `GBDTModel`

Loads and evaluates a trained model.

```typescript
import { loadModel } from "../research/inference/index.js";

const model = loadModel("research/artifacts/fwd_return_sign_5s.json");

model.predict(featuresArray);     // 0..1 probability (classification) or raw value (regression)
model.predictRaw(featuresArray);  // raw log-odds / score before sigmoid
model.featureNames;               // ["spread_bps", "microprice", ...]
model.objective;                  // "binary_crossentropy" etc.
model.metadata;                   // { feature_importance, train_metrics, test_metrics }
```

---

## Parity test

The critical integrity guarantee: Python features == TS features on same input.

```bash
cd research
python -m pytest tests/test_parity.py -v
```

This builds a synthetic book + trades + mids, computes features in Python,
runs the TS parity-check script on the same input, and asserts all 15 values
match within 1e-12. **If this test fails, the model sees different data in
production than it trained on.**

---

## Adding a new feature

1. Add the definition to `research/spec/features.json`
2. Add the Python implementation in `research/src/features.py`
   — add the function + include it in `compute_all()` and `FEATURE_NAMES`
3. Add the TS implementation in `src/research/inference/features.ts`
   — add the function + include it in `FeatureState.compute()` and `FEATURE_NAMES`
4. Update the parity test fixture if needed
5. Run `python -m pytest tests/test_parity.py -v` — must pass

---

## Directory layout

```
research/
├── spec/
│   ├── features.json       # Feature + label definitions (the contract)
│   └── model_format.json   # JSON tree format documentation
├── src/
│   ├── config.py            # Paths, defaults
│   ├── data.py              # Parquet loader, BookState, TradeWindow, MidHistory
│   ├── features.py          # 15 feature functions
│   ├── labels.py            # Forward-return label generator
│   ├── dataset.py           # Orchestrator: events → features → labels → DataFrame
│   └── train.py             # Time-split, LightGBM, JSON export
├── scripts/
│   ├── build_dataset.py     # CLI: build dataset
│   └── train_model.py       # CLI: train + export model
├── tests/
│   └── test_parity.py       # Python ↔ TS feature parity test
├── datasets/                # Built datasets (gitignored)
├── artifacts/               # Exported models (gitignored)
└── pyproject.toml

src/research/inference/
├── features.ts              # FeatureState — same 15 features from LocalBook
├── model.ts                 # GBDTModel — load JSON, evaluate trees
├── index.ts                 # Public API
└── parity-check.ts          # Helper for the parity test
```
