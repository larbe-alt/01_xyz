import type { Nord, NordUser, OrderbookInfo } from "@n1xyz/nord-ts";
import { Side, FillMode, calcCurrPosLiqPrice, calcPosMaintenanceMargin, estimateClosePnl } from "@n1xyz/nord-ts";
import { Decimal } from "../utils/decimal.js";
import { createLogger } from "../utils/logger.js";
import { byId, bySymbol, idToSymbol, marketRoundSize } from "../registry/markets.js";
import type { WriteQueue } from "./queue.js";
import type { AccountState } from "./account.js";

const log = createLogger("core:positions");

export interface Position {
  marketId: number;
  symbol: string;
  baseSize: Decimal;
  isLong: boolean;
  entryPrice: Decimal;
  unrealizedPnl: Decimal;
  fundingPnl: Decimal;
  openOrders: number;
}

export class PositionManager {
  constructor(
    private readonly nord: Nord,
    private readonly user: NordUser,
    private readonly queue: WriteQueue,
    private readonly account: AccountState,
  ) {}

  private rawPositions(accountId?: number) {
    const id = accountId ?? this.account.accountId;
    return this.user.positions[String(id)] ?? [];
  }

  private normalize(p: { marketId: number; perp?: any; openOrders: number }): Position {
    const perp = p.perp;
    const baseSize = new Decimal(perp.baseSize);
    return {
      marketId: p.marketId,
      symbol: idToSymbol(p.marketId),
      baseSize: baseSize.abs(),
      isLong: perp.isLong,
      entryPrice: new Decimal(perp.price),
      unrealizedPnl: new Decimal(perp.sizePricePnl),
      fundingPnl: new Decimal(perp.fundingPaymentPnl),
      openOrders: p.openOrders,
    };
  }

  list(accountId?: number): Position[] {
    return this.rawPositions(accountId)
      .filter((p) => p.perp && p.perp.baseSize !== 0)
      .map((p) => this.normalize(p));
  }

  get(symbol: string, accountId?: number): Position | null {
    const marketId = bySymbol(symbol).marketId;
    const raw = this.rawPositions(accountId).find(
      (p) => p.marketId === marketId && p.perp && p.perp.baseSize !== 0,
    );
    return raw ? this.normalize(raw) : null;
  }

  async liquidationPrice(symbol: string, accountId?: number): Promise<Decimal | null> {
    const allPositions = this.list(accountId);
    const meta = bySymbol(symbol);
    const pos = allPositions.find((p) => p.marketId === meta.marketId);
    if (!pos) return null;

    const marketLive = await this.nord.getMarketLive({ marketId: meta.marketId });
    if (marketLive.indexPrice == null) return null;

    const others = allPositions.filter((p) => p.marketId !== pos.marketId);
    const otherResults = await Promise.all(
      others.map(async (other) => {
        const otherMeta = byId(other.marketId);
        const otherLive = await this.nord.getMarketLive({ marketId: other.marketId });
        if (otherLive.indexPrice == null) return null;
        return calcPosMaintenanceMargin({
          baseSize: other.baseSize,
          isLong: other.isLong,
          indexPrice: otherLive.indexPrice,
          mmfBase: otherMeta.mmf,
        });
      }),
    );

    let otherMmf = new Decimal(0);
    for (const mmf of otherResults) {
      if (mmf) otherMmf = otherMmf.plus(mmf);
    }

    return calcCurrPosLiqPrice({
      baseSize: pos.baseSize,
      isLong: pos.isLong,
      indexPrice: marketLive.indexPrice,
      indexPriceConf: marketLive.indexPriceConf,
      mmfBase: meta.mmf,
      accountEquity: this.account.equity(accountId),
      otherPositionsMmf: otherMmf,
    });
  }

  async closePnlEstimate(symbol: string, accountId?: number): Promise<{
    estimatePnl: Decimal;
    avgExitPrice: Decimal | null;
    fullyFilled: boolean;
    unfilledSize: number;
  } | null> {
    const pos = this.get(symbol, accountId);
    if (!pos) return null;

    const orderbook = await this.nord.getOrderbook({ symbol }) as OrderbookInfo;
    const signedSize = pos.isLong ? pos.baseSize : pos.baseSize.negated();

    return estimateClosePnl({
      entryPrice: pos.entryPrice,
      baseSize: signedSize,
      orderbook,
    });
  }

  async close(symbol: string, fraction = 1, accountId?: number): Promise<void> {
    const pos = this.get(symbol, accountId);
    if (!pos) {
      log.warn("No position to close", { symbol });
      return;
    }

    const meta = bySymbol(symbol);
    const closeSize = fraction < 1
      ? marketRoundSize(symbol, pos.baseSize.mul(fraction))
      : pos.baseSize;

    if (closeSize.isZero()) return;

    const closeSide = pos.isLong ? Side.Ask : Side.Bid;

    await this.queue.enqueue(() =>
      this.user.placeOrder({
        marketId: meta.marketId,
        side: closeSide,
        fillMode: FillMode.ImmediateOrCancel,
        isReduceOnly: true,
        size: closeSize,
        accountId,
      }),
    );

    log.info("Position closed", { symbol, side: closeSide, size: closeSize.toString(), fraction });
  }

  async pnlHistory(accountId?: number, opts?: { since?: string; until?: string; pageSize?: number | null }) {
    const id = accountId ?? this.account.accountId;
    return this.nord.getAccountPnl(id, opts);
  }

  async pnlSummary(accountId?: number, opts?: { since?: string; until?: string; marketId?: number | null }) {
    const id = accountId ?? this.account.accountId;
    return this.nord.getAccountPnlSummary(id, opts);
  }

  async positionHistory(accountId?: number, opts?: { since?: string; until?: string; marketId?: number | null }) {
    const id = accountId ?? this.account.accountId;
    return this.nord.getAccountPositionHistory(id, opts);
  }
}
