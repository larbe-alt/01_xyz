import type { Nord, NordUser } from "@n1xyz/nord-ts";
import { Decimal } from "../utils/decimal.js";
import { createLogger } from "../utils/logger.js";
import type { WriteQueue } from "./queue.js";
import type { AccountState } from "./account.js";

const log = createLogger("core:balances");

export interface TokenBalance {
  symbol: string;
  balance: Decimal;
  accountId: number;
}

export class BalanceManager {
  constructor(
    private readonly nord: Nord,
    private readonly user: NordUser,
    private readonly queue: WriteQueue,
    private readonly account: AccountState,
  ) {}

  exchange(accountId?: number): TokenBalance[] {
    const id = accountId ?? this.account.accountId;
    const raw = this.user.balances[String(id)] ?? [];
    return raw.map((b) => ({
      symbol: b.symbol,
      balance: new Decimal(b.balance),
      accountId: b.accountId,
    }));
  }

  async onchain(opts?: {
    includeZeroBalances?: boolean;
    includeTokenAccounts?: boolean;
  }): Promise<{ balances: Record<string, number>; tokenAccounts?: Record<string, string> }> {
    return this.user.getSolanaBalances(opts);
  }

  free(token: string, accountId?: number): Decimal {
    const id = accountId ?? this.account.accountId;
    const raw = this.user.balances[String(id)] ?? [];
    const entry = raw.find((b: any) => b.symbol === token);
    if (!entry) return new Decimal(0);
    const margins = this.account.rawMargins(accountId);
    const used = Math.abs(Number(margins.omf) - Number(margins.mf));
    return Decimal.max(new Decimal(entry.balance).minus(used), 0);
  }

  async deposit(params: { amount: number; tokenId: number }) {
    const result = await this.user.deposit(params);
    log.info("Deposit submitted", { tokenId: params.tokenId, amount: params.amount, signature: result.signature });
    return result;
  }

  async withdraw(params: { tokenId: number; amount: number; destPubkey?: string }, accountId?: number) {
    const id = accountId ?? this.account.accountId;
    const fee = await this.nord.getAccountWithdrawalFee(id);
    log.info("Withdrawal fee", { fee });

    const result = await this.queue.enqueue(() => this.user.withdraw(params));
    log.info("Withdrawal submitted", { tokenId: params.tokenId, amount: params.amount, actionId: result.actionId.toString() });
    return { ...result, fee };
  }
}
