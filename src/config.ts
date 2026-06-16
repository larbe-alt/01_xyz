import "dotenv/config";

export type Network = "devnet" | "mainnet";

export interface Config {
  network: Network;
  solanaRpc: string;
  webServerUrl: string;
  wsHost: string;
  appKey: string;
  privateKey: string | undefined;
}

const PRESETS: Record<Network, { webServerUrl: string; wsHost: string; appKey: string }> = {
  devnet: {
    webServerUrl: "https://zo-devnet.n1.xyz",
    wsHost: "wss://zo-devnet.n1.xyz",
    appKey: "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
  },
  mainnet: {
    webServerUrl: "https://zo-mainnet.n1.xyz",
    wsHost: "wss://zo-mainnet.n1.xyz",
    appKey: "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
  },
};

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export function loadConfig(): Config {
  const network = (process.env.NETWORK ?? "devnet") as Network;
  if (network !== "devnet" && network !== "mainnet") {
    throw new Error(`NETWORK must be "devnet" or "mainnet", got "${network}"`);
  }
  const preset = PRESETS[network];

  return {
    network,
    solanaRpc:
      network === "mainnet"
        ? (process.env.SOLANA_RPC_MAINNET ?? process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com")
        : (process.env.SOLANA_RPC ?? "https://api.devnet.solana.com"),
    webServerUrl: process.env.WEB_SERVER_URL ?? preset.webServerUrl,
    wsHost: process.env.WS_HOST ?? preset.wsHost,
    appKey: process.env.APP_KEY ?? preset.appKey,
    privateKey: process.env.PRIVATE_KEY,
  };
}
