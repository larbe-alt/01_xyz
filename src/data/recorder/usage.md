# Recorder

Captures live market data from 01 Exchange into ZSTD-compressed Parquet files
for backtesting and research. No WAL — records buffer in memory and flush
directly to Parquet on a short rotation (default 5 min). Crash loses at most
one rotation window of public market data.

## Quick start

```bash
# Record all streams for BTC-PERP and ETH-PERP
npm run record -- --markets BTC-PERP,ETH-PERP

# Trades and candles only, 1-minute rotation, custom output dir
npm run record -- -m BTC-PERP -s trade,candle -r 1 -o ./my-data
```

Ctrl+C stops gracefully — flushes all in-memory buffers to Parquet before exit.

## CLI flags

| Flag         | Short | Default   | Description                                               |
|--------------|-------|-----------|-----------------------------------------------------------|
| `--markets`  | `-m`  | required  | Comma-separated market symbols, e.g. `BTC-PERP,ETH-PERP` |
| `--streams`  | `-s`  | all five  | `trade,delta,snapshot,candle,mark`                        |
| `--out`      | `-o`  | `./data`  | Base output directory                                     |
| `--rotation` | `-r`  | `5`       | Rotation interval in minutes                              |

## Streams

| Stream     | Source                          | What it captures                                         |
|------------|---------------------------------|----------------------------------------------------------|
| `trade`    | WS `trade` events               | Every fill: price, size, side, trade_id, action_id       |
| `delta`    | WS `delta` events               | Orderbook incremental updates (changed bid/ask levels)   |
| `snapshot` | `feed.getBook()` poll (60s)     | Top-50 book snapshot — resync anchor for delta replay    |
| `candle`   | WS `candle` events              | 1-min OHLCV bars                                         |
| `mark`     | `getMarketsLive()` poll (10s)   | Mark price, funding rate, open interest, index price     |

## Output layout

```
data/
  devnet/
    trade/
      BTC-PERP/
        2026-06-15T00-00.parquet
        2026-06-15T00-05.parquet
        ...
    delta/
      BTC-PERP/
        2026-06-15T00-00.parquet
    snapshot/
      BTC-PERP/
        2026-06-15T00-00.parquet
    candle/
      BTC-PERP/
        2026-06-15T00-00.parquet
    mark/
      BTC-PERP/
        2026-06-15T00-00.parquet
```

Each file covers one rotation window. Filename is the UTC start time of that
window. All files are Parquet with ZSTD compression.

## Querying with DuckDB

DuckDB reads the files natively — no loading step:

```sql
-- All trades for a day
SELECT * FROM read_parquet('data/devnet/trade/BTC-PERP/2026-06-15*.parquet')
ORDER BY ts;

-- VWAP over all recorded trades
SELECT
  symbol,
  SUM(price * size) / SUM(size) AS vwap,
  COUNT(*) AS fills
FROM read_parquet('data/devnet/trade/BTC-PERP/*.parquet')
GROUP BY symbol;

-- Candles
SELECT * FROM read_parquet('data/devnet/candle/BTC-PERP/*.parquet')
ORDER BY ts;

-- Funding rate history
SELECT ts, mark_price, funding_rate, open_interest
FROM read_parquet('data/devnet/mark/BTC-PERP/*.parquet')
ORDER BY ts;
```

## Replay (backtesting)

`ReplayFeed` reads recorded Parquet and emits the same events as `LiveFeed`.
A strategy written against `LiveFeed` runs on `ReplayFeed` with zero changes.

```ts
import { ReplayFeed } from "./data/recorder/replay.js";

const replay = new ReplayFeed({
  baseDir: "./data",
  env: "devnet",
  markets: ["BTC-PERP"],
  streams: ["trade", "candle"],
  from: Date.parse("2026-06-15T00:00Z"),  // optional
  to:   Date.parse("2026-06-16T00:00Z"),  // optional
  speed: 10,  // 10x real-time; omit or Infinity for instant
});

replay.on("connected",    () => console.log("replay started"));
replay.on("trade",       (t) => console.log(t.price, t.size, t.side));
replay.on("candle",      (c) => console.log(c.o, c.h, c.l, c.c));
replay.on("disconnected", () => console.log("replay done"));

await replay.start();
```

### ReplayOptions

| Field     | Type         | Description                                                          |
|-----------|--------------|----------------------------------------------------------------------|
| `baseDir` | `string`     | Same base dir used during recording                                  |
| `env`     | `string`     | `"devnet"` or `"mainnet"`                                            |
| `markets` | `string[]`   | Markets to replay                                                    |
| `streams` | `StreamType[]` | Which streams to include                                           |
| `from`    | `number?`    | Start timestamp ms (inclusive)                                       |
| `to`      | `number?`    | End timestamp ms (inclusive)                                         |
| `speed`   | `number?`    | Playback multiplier. `1` = real-time, `10` = 10x, omit = instant    |

## Programmatic usage

```ts
import { Recorder } from "./data/recorder/recorder.js";
import { closeSharedDb } from "./data/recorder/writers.js";

const recorder = new Recorder(nord, feed, {
  markets: ["BTC-PERP", "ETH-PERP"],
  streams: ["trade", "delta", "snapshot", "mark"],  // candle omitted by default
  baseDir: "./data",
  env: "devnet",
  rotationMs:        5 * 60_000,  // 5-min Parquet files
  markPollMs:            2_000,   // poll mark/funding every 2s
  snapshotIntervalMs:   60_000,   // full book snapshot every 60s
  snapshotDepth:            50,   // top-50 levels per side
});

recorder.start();
// ...
await recorder.stop();  // flushes remaining buffers to Parquet
await closeSharedDb();  // close DuckDB
```

## Record schema

Every record shares a common envelope:

| Field       | Type     | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `v`           | `number`          | Schema version (currently `2`)                           |
| `stream`      | `string`          | `"trade"`, `"delta"`, `"snapshot"`, `"candle"`, `"mark"` |
| `symbol`      | `string`          | Market symbol e.g. `"BTC-PERP"`                         |
| `market_id`   | `number`          | Numeric market ID                                        |
| `ts`          | `number`          | Receive clock — `Date.now()` at local ingest (ms)        |
| `ts_exchange` | `number \| null`  | Exchange event time (ms), or `null` if unavailable       |

**`ts` is the single coherent ordering key across all streams** — it is the
receive clock, i.e. the order in which the bot actually observed events. A
faithful replay/sim must process in this order (it can never react before it
has received an event); ordering by exchange time would inject look-ahead bias.
Use `update_id` for exact book sequencing within the delta/snapshot streams.

`ts_exchange` source by stream:
- **trade** — server `physical_time` parsed to ms (true exchange time)
- **candle** — candle open time (`t * 1000`)
- **delta, snapshot, mark** — `null` (exchange provides no timestamp; deltas
  carry only `update_id`, snapshots are synthesized locally, marks are REST-polled)

`ts - ts_exchange` for trades = feed latency.

### Per-stream fields

**trade**: `trade_id`, `action_id`, `side`, `price`, `size`

**delta**: `update_id`, `last_update_id`, `bids` (JSON), `asks` (JSON)

**snapshot**: `update_id`, `bids` (JSON top-50), `asks` (JSON top-50)

**candle**: `resolution`, `o`, `h`, `l`, `c`, `vol`

**mark**: `index_price`, `mark_price`, `funding_rate`, `next_funding_time`, `open_interest`

## Architecture

```
LiveFeed events ──▶ Recorder ──▶ ParquetWriter (one per stream+symbol)
                        │              │
  getMarketsLive poll ──┘         buffer[] in memory
                                       │
                                  rotation timer (5 min)
                                  or maxBufferSize hit
                                       │
                               write temp .ndjson
                               DuckDB COPY → .parquet (ZSTD)
                               delete temp .ndjson
```

All writes share one in-process DuckDB instance (`getSharedDb()`).
DuckDB serializes writes internally so concurrent rotations from multiple
writers are safe.

## Files

| File          | Purpose                                                      |
|---------------|--------------------------------------------------------------|
| `schema.ts`   | Record types + DuckDB column definitions                     |
| `writers.ts`  | `ParquetWriter` — buffer → rotate → ZSTD Parquet             |
| `recorder.ts` | `Recorder` — subscribes to LiveFeed, routes to writers       |
| `replay.ts`   | `ReplayFeed` — Parquet → LiveFeed-compatible EventEmitter    |
