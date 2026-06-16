import type { NordUser, Nord, NormalizedReceiptTrade } from "@n1xyz/nord-ts";
import { Side, FillMode } from "@n1xyz/nord-ts";
import type { SelfTradePrevention } from "@n1xyz/nord-ts";
import { Decimal } from "../utils/decimal.js";
import { serverNow } from "../utils/time.js";
import { createLogger } from "../utils/logger.js";
import { bySymbol, byId, symbolToId, idToSymbol, marketRoundPrice, marketRoundSize } from "../registry/markets.js";
import type { WriteQueue } from "./queue.js";
import type { AccountState } from "./account.js";
import { AtomicBuilder } from "./batch.js";

const log = createLogger("core:orders");

const CID_MULTIPLIER = BigInt(1_000_000);
let cidCounter = BigInt(0);

function nextClientOrderId(): bigint {
  if (cidCounter === BigInt(0)) {
    cidCounter = BigInt(Math.floor(serverNow())) * CID_MULTIPLIER;
  }
  cidCounter++;
  return cidCounter;
}

export interface PlaceIntent {
  symbol: string;
  side: Side;
  type: "limit" | "postOnly" | "ioc" | "fok" | "market";
  price?: Decimal.Value;
  size?: Decimal.Value;
  quoteSize?: Decimal.Value;
  reduceOnly?: boolean;
  clientOrderId?: bigint;
  stp?: SelfTradePrevention;
  accountId?: number;
}

export interface NormalizedOrder {
  orderId: number;
  marketId: number;
  symbol: string;
  side: Side;
  size: Decimal;
  price: Decimal;
  originalOrderSize: Decimal;
  clientOrderId: number | null;
}

export interface PlaceResult {
  actionId: bigint;
  orderId?: bigint;
  fills: NormalizedReceiptTrade[];
  reducedOrders: { orderId: bigint; remainingSize: number; cancelledSize: number; price: number }[];
  selfTradeCancels: { orderId: bigint; remainingSize: number; cancelledSize: number; price: number }[];
  clientOrderId: bigint;
}

const TYPE_TO_FILLMODE: Record<PlaceIntent["type"], FillMode> = {
  limit: FillMode.Limit,
  postOnly: FillMode.PostOnly,
  ioc: FillMode.ImmediateOrCancel,
  fok: FillMode.FillOrKill,
  market: FillMode.FillOrKill,
};

function normalizeOrder(raw: {
  orderId: number;
  marketId: number;
  side: "ask" | "bid";
  size: number;
  price: number;
  originalOrderSize: number;
  clientOrderId: number | null;
}): NormalizedOrder {
  return {
    orderId: raw.orderId,
    marketId: raw.marketId,
    symbol: idToSymbol(raw.marketId),
    side: raw.side === "ask" ? Side.Ask : Side.Bid,
    size: new Decimal(raw.size),
    price: new Decimal(raw.price),
    originalOrderSize: new Decimal(raw.originalOrderSize),
    clientOrderId: raw.clientOrderId,
  };
}

export class OrderManager {
  constructor(
    private readonly nord: Nord,
    private readonly user: NordUser,
    private readonly queue: WriteQueue,
    private readonly account: AccountState,
  ) {}

  async place(intent: PlaceIntent): Promise<PlaceResult> {
    const meta = bySymbol(intent.symbol);
    const fillMode = TYPE_TO_FILLMODE[intent.type];
    const cid = intent.clientOrderId ?? nextClientOrderId();

    let roundedSize: Decimal | undefined;
    if (intent.size !== undefined) {
      roundedSize = marketRoundSize(intent.symbol, intent.size);
      if (roundedSize.isZero()) throw new Error(`Size rounds to zero for ${intent.symbol}`);
    }

    const params = {
      marketId: meta.marketId,
      side: intent.side,
      fillMode,
      isReduceOnly: intent.reduceOnly ?? false,
      clientOrderId: cid,
      ...(intent.price !== undefined && { price: marketRoundPrice(intent.symbol, intent.price) }),
      ...(roundedSize !== undefined && { size: roundedSize }),
      ...(intent.quoteSize !== undefined && { quoteSize: intent.quoteSize }),
      ...(intent.stp && { selfTradePrevention: intent.stp }),
      ...(intent.accountId !== undefined && { accountId: intent.accountId }),
    };

    const result = await this.queue.enqueue(() => this.user.placeOrder(params));

    log.info("Order placed", {
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type,
      orderId: result.orderId?.toString(),
      fills: result.fills.length,
      cid: cid.toString(),
    });

    return { ...result, clientOrderId: cid };
  }

  async cancel(orderId: bigint | number, accountId?: number) {
    const result = await this.queue.enqueue(() => this.user.cancelOrder(orderId, accountId));
    log.info("Order cancelled", { orderId: result.orderId.toString() });
    return result;
  }

  async cancelByClientId(clientOrderId: bigint | number, accountId?: number) {
    const result = await this.queue.enqueue(() => this.user.cancelOrderByClientId(clientOrderId, accountId));
    log.info("Order cancelled by cid", { orderId: result.orderId.toString() });
    return result;
  }

  async edit(
    ref: bigint | number | { cid: bigint | number },
    changes: { price?: Decimal.Value; size?: Decimal.Value; symbol: string; side: Side; type?: PlaceIntent["type"] },
  ): Promise<PlaceResult> {
    const builder = new AtomicBuilder();
    if (typeof ref === "object" && "cid" in ref) {
      builder.cancelByClientId(ref.cid);
    } else {
      builder.cancel(ref);
    }

    const cid = nextClientOrderId();
    builder.place({
      symbol: changes.symbol,
      side: changes.side,
      fillMode: TYPE_TO_FILLMODE[changes.type ?? "limit"],
      price: changes.price,
      size: changes.size,
      clientOrderId: cid,
    });

    const result = await builder.submit(this.user, this.queue);
    log.info("Order edited (atomic cancel+place)", { cid: cid.toString() });

    return {
      actionId: result.actionId,
      fills: [],
      reducedOrders: [],
      selfTradeCancels: [],
      clientOrderId: cid,
    };
  }

  async cancelAll(symbol?: string, accountId?: number): Promise<void> {
    const open = this.open(symbol, accountId);
    if (open.length === 0) return;

    const chunks: NormalizedOrder[][] = [];
    for (let i = 0; i < open.length; i += 10) {
      chunks.push(open.slice(i, i + 10));
    }

    for (const chunk of chunks) {
      const actions = chunk.map((o) => ({
        kind: "cancel" as const,
        orderId: BigInt(o.orderId),
      }));
      await this.queue.enqueue(() => this.user.atomic(actions, accountId));
    }

    log.info("All orders cancelled", { count: open.length, symbol });
  }

  open(symbol?: string, accountId?: number): NormalizedOrder[] {
    const id = accountId ?? this.account.accountId;
    let raw = this.user.orders[String(id)] ?? [];
    if (symbol) {
      const marketId = symbolToId(symbol);
      raw = raw.filter((o: any) => o.marketId === marketId);
    }
    return raw.map(normalizeOrder);
  }

  getById(orderId: number, accountId?: number): NormalizedOrder | null {
    const id = accountId ?? this.account.accountId;
    const raw = this.user.orders[String(id)] ?? [];
    const entry = raw.find((o: any) => o.orderId === orderId);
    return entry ? normalizeOrder(entry) : null;
  }

  async reconcile(accountId?: number): Promise<NormalizedOrder[]> {
    const id = accountId ?? this.account.accountId;
    const result = await this.nord.getAccountOrders(id);
    log.info("Orders reconciled from server", { count: (result as any).items?.length ?? 0 });
    return this.open(undefined, id);
  }

  // convenience methods
  async marketBuy(symbol: string, size: Decimal.Value, accountId?: number): Promise<PlaceResult> {
    return this.place({ symbol, side: Side.Bid, type: "fok", size, accountId });
  }

  async marketSell(symbol: string, size: Decimal.Value, accountId?: number): Promise<PlaceResult> {
    return this.place({ symbol, side: Side.Ask, type: "fok", size, accountId });
  }

  async postOnly(symbol: string, side: Side, price: Decimal.Value, size: Decimal.Value, accountId?: number): Promise<PlaceResult> {
    return this.place({ symbol, side, type: "postOnly", price, size, accountId });
  }
}
