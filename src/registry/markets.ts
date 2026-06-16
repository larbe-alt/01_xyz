import type { Nord, Market } from "@n1xyz/nord-ts";
import { Decimal } from "decimal.js";
import { roundPrice, roundSize } from "../utils/decimal.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("registry:markets");

export interface MarketMeta {
  marketId: number;
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
  baseTokenId: number;
  quoteTokenId: number;
  imf: number;
  mmf: number;
  cmf: number;
}

let _markets: MarketMeta[] = [];
let _bySymbol = new Map<string, MarketMeta>();
let _byId = new Map<number, MarketMeta>();

function index(raw: Market[]) {
  _markets = raw.map((m) => ({
    marketId: m.marketId,
    symbol: m.symbol,
    priceDecimals: m.priceDecimals,
    sizeDecimals: m.sizeDecimals,
    baseTokenId: m.baseTokenId,
    quoteTokenId: m.quoteTokenId,
    imf: m.imf,
    mmf: m.mmf,
    cmf: m.cmf,
  }));
  _bySymbol = new Map(_markets.map((m) => [m.symbol, m]));
  _byId = new Map(_markets.map((m) => [m.marketId, m]));
  log.info("Markets indexed", { count: _markets.length });
}

export function initMarkets(nord: Nord): void {
  index(nord.markets);
}

export function initMarketsOffline(metas: MarketMeta[]): void {
  _markets = metas;
  _bySymbol = new Map(metas.map((m) => [m.symbol, m]));
  _byId = new Map(metas.map((m) => [m.marketId, m]));
}

export async function refreshMarkets(nord: Nord): Promise<void> {
  await nord.fetchNordInfo();
  index(nord.markets);
}

export function allMarkets(): MarketMeta[] {
  return _markets;
}

export function bySymbol(symbol: string): MarketMeta {
  const m = _bySymbol.get(symbol);
  if (!m) throw new Error(`Unknown market symbol: ${symbol}`);
  return m;
}

export function byId(id: number): MarketMeta {
  const m = _byId.get(id);
  if (!m) throw new Error(`Unknown market id: ${id}`);
  return m;
}

export function marketRoundPrice(symbol: string, price: Decimal.Value): Decimal {
  return roundPrice(price, bySymbol(symbol).priceDecimals);
}

export function marketRoundSize(symbol: string, size: Decimal.Value): Decimal {
  return roundSize(size, bySymbol(symbol).sizeDecimals);
}

export function symbolToId(symbol: string): number {
  return bySymbol(symbol).marketId;
}

export function idToSymbol(id: number): string {
  return byId(id).symbol;
}
