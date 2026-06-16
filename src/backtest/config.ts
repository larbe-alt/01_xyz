import type { RiskConfig } from "../risk/limits.js";
import type { FeeModel } from "../sim/types.js";

export interface BacktestMarketConfig {
  symbol: string;
  marketId: number;
  priceDecimals?: number;
  sizeDecimals?: number;
  imf?: number;
  mmf?: number;
  cmf?: number;
}

export interface BacktestConfig {
  strategy: string;
  markets: BacktestMarketConfig[];
  data: {
    dir: string;
    env: string;
    from?: number;
    to?: number;
  };
  risk: RiskConfig;
  params?: unknown;
  initialEquity: number;
  fees?: Partial<FeeModel>;
  tickMs?: number;
  /** Min ms between equity curve samples (default 0 = every event). Use 100–1000 for HFT datasets. */
  curveIntervalMs?: number;
}
