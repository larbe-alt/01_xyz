import "./utils/polyfills.js";
import { Nord, NordUser } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import { loadConfig, type Config } from "./config.js";
import { syncTime } from "./utils/time.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("client");

let _nord: Nord | null = null;
let _user: NordUser | null = null;
let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}

export async function getNord(): Promise<Nord> {
  if (_nord) return _nord;

  const cfg = getConfig();
  log.info("Initializing Nord client", { network: cfg.network, rpc: cfg.solanaRpc });

  const connection = new Connection(cfg.solanaRpc);
  _nord = await Nord.new({
    app: cfg.appKey,
    solanaConnection: connection,
    webServerUrl: cfg.webServerUrl,
  });

  await syncTime(_nord);
  log.info("Nord client ready", { markets: _nord.markets.length, tokens: _nord.tokens.length });
  return _nord;
}

export async function getUser(): Promise<NordUser> {
  if (_user) return _user;

  const cfg = getConfig();
  if (!cfg.privateKey) throw new Error("PRIVATE_KEY is not set in environment");

  const nord = await getNord();
  const user = NordUser.fromPrivateKey(nord, cfg.privateKey);
  await user.updateAccountId();
  await user.refreshSession();
  await user.fetchInfo();
  _user = user;

  log.info("User ready", { accounts: user.accountIds, pubkey: user.publicKey.toBase58() });
  return _user;
}

export async function close(): Promise<void> {
  _user = null;
  _nord = null;
  _config = null;
  log.info("Client closed");
}
