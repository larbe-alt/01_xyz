import type { NordUser, UserAtomicSubaction } from "@n1xyz/nord-ts";
import { Side, FillMode, TriggerKind } from "@n1xyz/nord-ts";
import type Decimal from "decimal.js";
import type { WriteQueue } from "./queue.js";
import { bySymbol, marketRoundPrice, marketRoundSize } from "../registry/markets.js";

const MAX_SUBACTIONS = 10;

export class AtomicBuilder {
  private actions: UserAtomicSubaction[] = [];

  cancel(orderId: bigint | number): this {
    this.actions.push({ kind: "cancel", orderId });
    return this;
  }

  cancelByClientId(clientOrderId: bigint | number): this {
    this.actions.push({ kind: "cancelByClientId", clientOrderId });
    return this;
  }

  place(params: {
    symbol: string;
    side: Side;
    fillMode: FillMode;
    isReduceOnly?: boolean;
    price?: Decimal.Value;
    size?: Decimal.Value;
    quoteSize?: Decimal.Value;
    clientOrderId?: bigint;
  }): this {
    const meta = bySymbol(params.symbol);
    this.actions.push({
      kind: "place",
      marketId: meta.marketId,
      side: params.side,
      fillMode: params.fillMode,
      isReduceOnly: params.isReduceOnly ?? false,
      ...(params.price !== undefined && { price: marketRoundPrice(params.symbol, params.price) }),
      ...(params.size !== undefined && { size: marketRoundSize(params.symbol, params.size) }),
      ...(params.quoteSize !== undefined && { quoteSize: params.quoteSize }),
      ...(params.clientOrderId !== undefined && { clientOrderId: params.clientOrderId }),
    });
    return this;
  }

  addTrigger(params: {
    symbol: string;
    side: Side;
    triggerKind: TriggerKind;
    triggerPrice: Decimal.Value;
    limitPrice?: Decimal.Value;
    limitBaseSize?: Decimal.Value;
    limitQuoteSize?: Decimal.Value;
  }): this {
    const meta = bySymbol(params.symbol);
    this.actions.push({
      kind: "addTrigger",
      marketId: meta.marketId,
      side: params.side,
      triggerKind: params.triggerKind,
      triggerPrice: params.triggerPrice,
      ...(params.limitPrice !== undefined && { limitPrice: params.limitPrice }),
      ...(params.limitBaseSize !== undefined && { limitBaseSize: params.limitBaseSize }),
      ...(params.limitQuoteSize !== undefined && { limitQuoteSize: params.limitQuoteSize }),
    });
    return this;
  }

  editTrigger(params: {
    triggerId: bigint | number;
    symbol: string;
    side: Side;
    triggerKind: TriggerKind;
    triggerPrice: Decimal.Value;
    limitPrice?: Decimal.Value;
    limitBaseSize?: Decimal.Value;
    limitQuoteSize?: Decimal.Value;
  }): this {
    const meta = bySymbol(params.symbol);
    this.actions.push({
      kind: "editTrigger",
      triggerId: params.triggerId,
      marketId: meta.marketId,
      side: params.side,
      triggerKind: params.triggerKind,
      triggerPrice: params.triggerPrice,
      ...(params.limitPrice !== undefined && { limitPrice: params.limitPrice }),
      ...(params.limitBaseSize !== undefined && { limitBaseSize: params.limitBaseSize }),
      ...(params.limitQuoteSize !== undefined && { limitQuoteSize: params.limitQuoteSize }),
    });
    return this;
  }

  removeTrigger(params: { symbol: string; triggerId: bigint | number }): this {
    const meta = bySymbol(params.symbol);
    this.actions.push({
      kind: "removeTrigger",
      marketId: meta.marketId,
      triggerId: params.triggerId,
    });
    return this;
  }

  get count(): number {
    return this.actions.length;
  }

  build(): UserAtomicSubaction[] {
    if (this.actions.length === 0) throw new Error("AtomicBuilder: no subactions");
    if (this.actions.length > MAX_SUBACTIONS) {
      throw new Error(`AtomicBuilder: ${this.actions.length} subactions exceeds limit of ${MAX_SUBACTIONS}`);
    }
    return this.actions;
  }

  async submit(user: NordUser, queue: WriteQueue, accountId?: number) {
    const actions = this.build();
    return queue.enqueue(() => user.atomic(actions, accountId));
  }
}
