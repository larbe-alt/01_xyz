export const SCHEMA_VERSION = 1;

export interface BaseRecord {
  v: number;
  stream: string;
  symbol: string;
  market_id: number;
  ts: number;
  ts_local: number;
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
    ts: 'DOUBLE', ts_local: 'DOUBLE',
    trade_id: 'DOUBLE', action_id: 'DOUBLE', side: 'VARCHAR',
    price: 'DOUBLE', size: 'DOUBLE'
  }`,
  delta: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_local: 'DOUBLE',
    update_id: 'DOUBLE', last_update_id: 'DOUBLE',
    bids: 'VARCHAR', asks: 'VARCHAR'
  }`,
  snapshot: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_local: 'DOUBLE',
    update_id: 'DOUBLE', bids: 'VARCHAR', asks: 'VARCHAR'
  }`,
  candle: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_local: 'DOUBLE',
    resolution: 'VARCHAR', o: 'DOUBLE', h: 'DOUBLE', l: 'DOUBLE', c: 'DOUBLE', vol: 'DOUBLE'
  }`,
  mark: `{
    v: 'UTINYINT', stream: 'VARCHAR', symbol: 'VARCHAR', market_id: 'UINTEGER',
    ts: 'DOUBLE', ts_local: 'DOUBLE',
    index_price: 'DOUBLE', mark_price: 'DOUBLE', funding_rate: 'DOUBLE',
    next_funding_time: 'VARCHAR', open_interest: 'DOUBLE'
  }`,
};
