import type { Nord, Token } from "@n1xyz/nord-ts";
import { createLogger } from "../utils/logger.js";

const log = createLogger("registry:tokens");

export interface TokenMeta {
  tokenId: number;
  symbol: string;
  decimals: number;
  mintAddr: string;
  weightBps: number;
}

let _tokens: TokenMeta[] = [];
let _bySymbol = new Map<string, TokenMeta>();
let _byId = new Map<number, TokenMeta>();

function index(raw: Token[]) {
  _tokens = raw.map((t) => ({
    tokenId: t.tokenId,
    symbol: t.symbol,
    decimals: t.decimals,
    mintAddr: t.mintAddr,
    weightBps: t.weightBps,
  }));
  _bySymbol = new Map(_tokens.map((t) => [t.symbol, t]));
  _byId = new Map(_tokens.map((t) => [t.tokenId, t]));
  log.info("Tokens indexed", { count: _tokens.length });
}

export function initTokens(nord: Nord): void {
  index(nord.tokens);
}

export async function refreshTokens(nord: Nord): Promise<void> {
  await nord.fetchNordInfo();
  index(nord.tokens);
}

export function allTokens(): TokenMeta[] {
  return _tokens;
}

export function tokenBySymbol(symbol: string): TokenMeta {
  const t = _bySymbol.get(symbol);
  if (!t) throw new Error(`Unknown token symbol: ${symbol}`);
  return t;
}

export function tokenById(id: number): TokenMeta {
  const t = _byId.get(id);
  if (!t) throw new Error(`Unknown token id: ${id}`);
  return t;
}

export function tokenIdToSymbol(id: number): string {
  return tokenById(id).symbol;
}

export function tokenSymbolToId(symbol: string): number {
  return tokenBySymbol(symbol).tokenId;
}
