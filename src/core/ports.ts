/**
 * Port interfaces — the seam between live SDK managers and sim adapters.
 *
 * The live managers (OrderManager, AccountState, PositionManager, BalanceManager)
 * structurally satisfy these; the sim adapters (src/sim/adapters.ts) implement
 * them over the matching engine. GuardedOrders and StrategyContext depend on the
 * interfaces, not the concrete classes, so strategies run unchanged in both modes.
 */
import type { Decimal } from "../utils/decimal.js";
import type { Side } from "@n1xyz/nord-ts";
import type { PlaceIntent, PlaceResult, NormalizedOrder } from "./orders.js";
import type { Position } from "./positions.js";
import type { TokenBalance } from "./balances.js";

export interface IOrderGateway {
  place(intent: PlaceIntent): Promise<PlaceResult>;
  cancel(orderId: bigint | number, accountId?: number): Promise<unknown>;
  cancelByClientId(clientOrderId: bigint | number, accountId?: number): Promise<unknown>;
  edit(
    ref: bigint | number | { cid: bigint | number },
    changes: { price?: Decimal.Value; size?: Decimal.Value; symbol: string; side: Side; type?: PlaceIntent["type"] },
  ): Promise<PlaceResult>;
  cancelAll(symbol?: string, accountId?: number): Promise<void>;
  open(symbol?: string, accountId?: number): NormalizedOrder[];
  getById(orderId: number, accountId?: number): NormalizedOrder | null;
}

export interface IAccount {
  readonly accountId: number;
  refresh(): Promise<void>;
  ageMs(): number;
  equity(accountId?: number): Decimal;
  rawMargins(accountId?: number): {
    mf: number;
    imf: number;
    omf: number;
    cmf: number;
    mmf: number;
    pon: number;
    pn: number;
    bankruptcy: boolean;
  };
}

export interface IPositions {
  list(accountId?: number): Position[];
  get(symbol: string, accountId?: number): Position | null;
  close(symbol: string, fraction?: number, accountId?: number): Promise<void>;
}

export interface IBalances {
  exchange(accountId?: number): TokenBalance[];
  free(token: string, accountId?: number): Decimal;
}
