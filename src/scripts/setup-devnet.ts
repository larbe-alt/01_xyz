import "dotenv/config";
import { Nord, NordUser } from "@n1xyz/nord-ts";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createLogger } from "../utils/logger.js";

const log = createLogger("setup-devnet");

async function main() {
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const nord = await Nord.new({
    app: process.env.APP_KEY ?? "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
    solanaConnection: connection,
    webServerUrl: process.env.WEB_SERVER_URL ?? "https://zo-devnet.n1.xyz",
  });

  log.info("Exchange tokens:");
  for (const t of nord.tokens) {
    log.info(`  id=${t.tokenId} sym=${t.symbol} dec=${t.decimals} mint=${t.mintAddr}`);
  }

  // Load or generate keypair
  let privateKeyBase58 = process.env.PRIVATE_KEY;

  if (!privateKeyBase58 || privateKeyBase58 === "your_base58_private_key_here") {
    log.info("\nNo valid PRIVATE_KEY. Generating a new devnet keypair...");
    const kp = Keypair.generate();
    privateKeyBase58 = bs58.encode(kp.secretKey);
    log.info(`Pubkey: ${kp.publicKey.toBase58()}`);
    log.info(`PRIVATE_KEY=${privateKeyBase58}`);
    log.info("Update your .env with the line above, then re-run.");
    return;
  }

  const secretKey = bs58.decode(privateKeyBase58);
  const wallet = Keypair.fromSecretKey(secretKey);
  log.info(`\nWallet: ${wallet.publicKey.toBase58()}`);

  // Check SOL
  let balance = await connection.getBalance(wallet.publicKey);
  log.info(`SOL balance: ${balance / LAMPORTS_PER_SOL}`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    log.info("Requesting SOL airdrop (2 SOL)...");
    try {
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      balance = await connection.getBalance(wallet.publicKey);
      log.info(`Airdrop done. SOL balance: ${balance / LAMPORTS_PER_SOL}`);
    } catch (err) {
      log.error("Airdrop failed — try https://faucet.solana.com", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // Check USDC
  const usdcToken = nord.tokens.find((t) => t.symbol === "USDC");
  if (!usdcToken) {
    log.error("No USDC token on exchange");
    return;
  }
  log.info(`\nExchange USDC mint: ${usdcToken.mintAddr} (tokenId=${usdcToken.tokenId})`);

  const usdcMint = new PublicKey(usdcToken.mintAddr);
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: usdcMint });
  const usdcBalance = tokenAccounts.value.length > 0
    ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmountString
    : "0";
  log.info(`Wallet USDC balance: ${usdcBalance}`);

  // Try creating user
  log.info("\nChecking exchange account...");
  const user = NordUser.fromPrivateKey(nord, privateKeyBase58);

  try {
    await user.updateAccountId();
    await user.fetchInfo();
    log.info("Account exists!", { accountIds: user.accountIds });

    const id = user.accountIds?.[0];
    if (id !== undefined) {
      const bals = user.balances[String(id)] ?? [];
      for (const b of bals) log.info(`  Exchange ${b.symbol}: ${b.balance}`);
      const margins = user.margins[String(id)];
      if (margins) log.info(`  Equity (mf): ${margins.mf}, Margin usage (omf): ${margins.omf}`);
    }
    log.info("\nReady to run: npm run test:core");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      log.info("Account not yet created on exchange.");

      if (Number(usdcBalance) > 0) {
        log.info("You have USDC — attempting deposit to create account...");
        try {
          const depositAmount = Math.min(Number(usdcBalance), 100);
          const result = await user.deposit({ amount: depositAmount, tokenId: usdcToken.tokenId });
          log.info("Deposit submitted!", { signature: result.signature });
          log.info("Wait ~15s for processing, then re-run this script.");
        } catch (depErr) {
          log.error("Deposit failed", { error: depErr instanceof Error ? depErr.message : String(depErr) });
        }
      } else {
        log.info("\nYou need devnet USDC to create the account.");
        log.info(`USDC mint: ${usdcToken.mintAddr}`);
        log.info(`Wallet: ${wallet.publicKey.toBase58()}`);
        log.info("\nTo get devnet USDC, try:");
        log.info("  1. 01.xyz devnet UI (may have built-in faucet)");
        log.info("  2. spl-token-faucet.com if this mint is supported");
        log.info("  3. Ask in 01 Exchange Discord for devnet tokens");
      }
    } else {
      log.error("Unexpected error", { error: msg });
    }
  }
}

main().catch((err) => {
  log.error("Failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
