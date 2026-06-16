import "dotenv/config";
import { Nord, NordUser } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deposit-devnet");

async function main() {
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const nord = await Nord.new({
    app: process.env.APP_KEY ?? "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
    solanaConnection: connection,
    webServerUrl: process.env.WEB_SERVER_URL ?? "https://zo-devnet.n1.xyz",
  });

  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY not set");

  const user = NordUser.fromPrivateKey(nord, pk);

  // Deposit 100 USDC (tokenId=0) to create the account
  const amount = 100;
  const tokenId = 0;
  log.info(`Depositing ${amount} USDC (tokenId=${tokenId})...`);

  const result = await user.deposit({ amount, tokenId });
  log.info("Deposit tx submitted", { signature: result.signature });

  // Wait for processing
  log.info("Waiting 10s for exchange to process...");
  await new Promise((r) => setTimeout(r, 10_000));

  // Now try to update account
  try {
    await user.updateAccountId();
    await user.fetchInfo();
    log.info("Account created!", { accountIds: user.accountIds });
    const id = user.accountIds?.[0];
    if (id !== undefined) {
      const bals = user.balances[String(id)] ?? [];
      for (const b of bals) log.info(`  ${b.symbol}: ${b.balance}`);
    }
  } catch (err) {
    log.info("Account not ready yet — wait a bit and run: npx tsx src/scripts/setup-devnet.ts");
    log.error("Error", { error: err instanceof Error ? err.message : String(err) });
  }
}

main().catch((err) => {
  log.error("Failed", { error: err instanceof Error ? err.message : String(err), stack: (err as Error).stack });
  process.exit(1);
});
