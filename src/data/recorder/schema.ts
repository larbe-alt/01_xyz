export const SCHEMA_VERSION = 2;

export interface BaseRecord {
  v: number;
  stream: string;
  symbol: string;
  market_id: number;
  /**
   * Receive clock: Date.now() at the instant we ingested the event locally.
   * This is the ONE coherent ordering key across every stream — a faithful
   * replay/sim must process events in the order the bot actually observed
   * them (it can never react before it has received an event). Ordering by
   * exchange time instead would inject look-ahead bias, since a delta's
   * exchange instant precedes when we hold it. Use `update_id` for exact
   * book sequencing within a stream.
   */
  ts: number;
  /**
   * Exchange event time (ms since epoch) where the protocol provides it —
   * trades (`physical_time`) and candles (`t`). null for streams the exchange
   * does not timestamp: delta (book diffs carry only `update_id`), locally
   * synthesized snapshots, and REST-polled marks. Feed latency for trades =
   * `ts - ts_exchange`.
   */
  ts_exchange: number | null;
}

export interface TradeRecord extends BaseRecord {
  stream: "trade";
  trade_id: number;
  action_id: number;
  side: string;
  price: number;
  size: number;
}

export interface DeltaRecord extends BaseRecord {
  stream: "delta";
  update_id: number;
  last_update_id: number;
  bids: string;
  asks: string;
}

export interface SnapshotRecord extends BaseRecord {
  stream: "snapshot";
  update_id: number;
  bids: string;
  asks: string;
}

export interface CandleRecord extends BaseRecord {
  stream: "candle";
  resolution: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
}

export interface MarkRecord extends BaseRecord {
  stream: "mark";
  index_price: number | null;
  mark_price: number | null;
  funding_rate: number | null;
  next_funding_time: string | null;
  open_interest: number;
}

export type AnyRecord = TradeRecord | DeltaRecord | SnapshotRecord | CandleRecord | MarkRecord;

export type StreamType = AnyRecord["stream"];

// DOUBLE instead of BIGINT: all IDs/timestamps fit in double's safe integer
// range (2^53) and avoids DuckDB returning JS BigInt values
export const DUCKDB_COLUMNS: Record<StreamType, string> = {
  trade: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_exchange: 'DOUBLE',
    trade_id: 'DOUBLE', action_id: 'DOUBLE', side: 'VARCHAR',
    price: 'DOUBLE', size: 'DOUBLE'
  }`,
  delta: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_exchange: 'DOUBLE',
    update_id: 'DOUBLE', last_update_id: 'DOUBLE',
    bids: 'VARCHAR', asks: 'VARCHAR'
  }`,
  snapshot: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_exchange: 'DOUBLE',
    update_id: 'DOUBLE', bids: 'VARCHAR', asks: 'VARCHAR'
  }`,
  candle: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_exchange: 'DOUBLE',
    resolution: 'VARCHAR', o: 'DOUBLE', h: 'DOUBLE', l: 'DOUBLE', c: 'DOUBLE', vol: 'DOUBLE'
  }`,
  mark: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_exchange: 'DOUBLE',
    index_price: 'DOUBLE', mark_price: 'DOUBLE', funding_rate: 'DOUBLE',
    next_funding_time: 'VARCHAR', open_interest: 'DOUBLE'
  }`,
};
