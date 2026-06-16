import type { Nord, NordUser, AccountMarginsView } from "@n1xyz/nord-ts";
import { getAccountMarginUsageRatio, getPerpsCrossMarginRatio } from "@n1xyz/nord-ts";
import { Decimal } from "../utils/decimal.js";
import { createLogger } from "../utils/logger.js";
import type { WriteQueue } from "./queue.js";

const log = createLogger("core:account");

export class AccountState {
  private lastRefreshMs = 0;
  // Single-flight: concurrent refresh() callers (account WS bursts + the periodic
  // timer) share one in-flight fetchInfo() so they can't interleave-write user.* state.
  private inflightRefresh: Promise<void> | null = null;

  constructor(
    private readonly nord: Nord,
    private readonly user: NordUser,
    private readonly queue: WriteQueue,
  ) {}

  get accountId(): number {
    const ids = this.user.accountIds;
    if (!ids || ids.length === 0) throw new Error("No account IDs available");
    return ids[0];
  }

  get allAccountIds(): number[] {
    return this.user.accountIds ?? [];
  }

  async refresh(): Promise<void> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = (async () => {
      try {
        await this.user.fetchInfo();
        this.lastRefreshMs = Date.now();
        log.debug("Account state refreshed", { accountId: this.accountId });
      } finally {
        this.inflightRefresh = null;
      }
    })();
    return this.inflightRefresh;
  }

  ageMs(): number {
    if (this.lastRefreshMs === 0) return Infinity;
    return Date.now() - this.lastRefreshMs;
  }

  private margins(accountId?: number): AccountMarginsView {
    const id = accountId ?? this.accountId;
    const m = this.user.margins[String(id)];
    if (!m) throw new Error(`No margins for account ${id}`);
    return m;
  }

  equity(accountId?: number): Decimal {
    return new Decimal(this.margins(accountId).mf);
  }

  marginUsage(accountId?: number): Decimal {
    return getAccountMarginUsageRatio(this.margins(accountId));
  }

  crossMarginRatio(accountId?: number): Decimal {
    return getPerpsCrossMarginRatio(this.margins(accountId));
  }

  isBankrupt(accountId?: number): boolean {
    return this.margins(accountId).bankruptcy;
  }

  rawMargins(accountId?: number): AccountMarginsView {
    return this.margins(accountId);
  }

  async transferOwned(params: {
    tokenId: number;
    amount: Decimal.Value;
    fromAccountId: number;
    toAccountId?: number;
  }) {
    return this.queue.enqueue(() => this.user.transferOwned(params));
  }

  async transferUnowned(params: {
    tokenId: number;
    amount: Decimal.Value;
    fromAccountId: number;
    toAccountId: number;
  }) {
    return this.queue.enqueue(() => this.user.transferUnowned(params));
  }
}
