/**
 * Identified-trade schema — the per-trader tape pulled from the `getTrades`
 * REST endpoint (Nord.getTrades), NOT the anonymous WS `trade` stream the
 * recorder captures (src/data/recorder/schema.ts has no taker/maker IDs).
 *
 * This is the only 01 source that attributes a fill to an account, so it's the
 * foundation for trader-pattern analytics (top volume, maker/taker, PnL, fees).
 *
 * Layout mirrors the recorder: data/<env>/trades_id/<SYMBOL>/*.parquet, so the
 * existing DuckDB glob loaders read it the same way as native01 streams.
 *
 * DOUBLE for all IDs (the recorder's convention): every ID/ts fits in double's
 * 2^53 safe-integer range, and it avoids DuckDB handing back JS BigInt values.
 */
export const TRADES_SCHEMA_VERSION = 1;

export interface IdentifiedTrade {
  v: number;
  symbol: string;
  market_id: number;
  ts: number; // ms epoch, parsed from the RFC3339 `time` field
  trade_id: number;
  action_id: number;
  order_id: number;
  taker_id: number;
  maker_id: number;
  taker_side: string; // "bid" | "ask" — the aggressor's side
  price: number;
  base_size: number;
  // Null for historical trades recorded before fee capture was added on 01.
  taker_fee: number | null;
  maker_fee: number | null;
}

export const IDENTIFIED_TRADE_COLUMNS = `{
  v: 'UTINYINT', symbol: 'VARCHAR', market_id: 'UINTEGER',
  ts: 'DOUBLE', trade_id: 'DOUBLE', action_id: 'DOUBLE', order_id: 'DOUBLE',
  taker_id: 'DOUBLE', maker_id: 'DOUBLE', taker_side: 'VARCHAR',
  price: 'DOUBLE', base_size: 'DOUBLE',
  taker_fee: 'DOUBLE', maker_fee: 'DOUBLE'
}`;
