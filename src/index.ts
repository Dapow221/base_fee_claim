import fs from "node:fs";
import path from "node:path";

type Hex = `0x${string}`;
type Address = `0x${string}`;

type RpcLog = {
  address: Address;
  blockNumber: Hex;
  data: Hex;
  logIndex: Hex;
  removed: boolean;
  topics: Hex[];
  transactionHash: Hex;
};

type RpcReceipt = {
  blockNumber: Hex;
  logs: RpcLog[];
  status: Hex;
  transactionHash: Hex;
};

type State = {
  lastScannedBlock: number;
  alertedTxs: string[];
  bankrLaunches: Record<string, BankrLaunch>;
  lastBankrLaunchRefreshAt: number;
};

type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
};

type Transfer = {
  token: TokenInfo;
  from: Address;
  to: Address;
  rawAmount: bigint;
  amount: string;
};

type Release = {
  contract: Address;
  poolId: Hex;
  beneficiary: Address;
  fees0: bigint;
  fees1: bigint;
  blockNumber: number;
  txHash: Hex;
};

type Collect = {
  contract: Address;
  poolId: Hex;
  fees0: bigint;
  fees1: bigint;
};

type MarketInfo = {
  name: string;
  symbol: string;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
};

type ClaimSummary = {
  releases: Release[];
  releasedTransfers: Transfer[];
  collectedTransfers: Transfer[];
  bankrLaunch?: BankrLaunch;
};

type BankrLaunch = {
  tokenAddress: Address;
  tokenName: string;
  tokenSymbol: string;
  chain: string;
  launchType?: string;
  poolId?: Hex;
  txHash?: Hex;
  timestamp?: number;
  deployer?: {
    walletAddress?: Address;
    xUsername?: string;
  };
  feeRecipient?: {
    walletAddress?: Address;
    xUsername?: string;
  };
  tweetUrl?: string;
  websiteUrl?: string;
};

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const RELEASE_TOPIC =
  "0x951cb665214ddfa483febb22b592b0c67f38eac40f7be33f6fcbbe63289276d1" as Hex;
const COLLECT_TOPIC =
  "0xad34f511970a4cac65bf0c3c9cc235ce712b801c0c90c20599ca002c233dcd21" as Hex;
const SYMBOL_SELECTOR = "0x95d89b41" as Hex;
const DECIMALS_SELECTOR = "0x313ce567" as Hex;
const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;

loadDotEnv();

const config = {
  rpcUrl: env("BASE_RPC_URL", "https://mainnet.base.org"),
  feeDistributorAddresses: addressListEnv("FEE_DISTRIBUTOR_ADDRESSES"),
  minRawClaimAmount: BigInt(env("MIN_RAW_CLAIM_AMOUNT", "0")),
  minEthClaimWei: parseUnits(env("MIN_ETH_CLAIM_AMOUNT", "0.1"), 18),
  requireBankrLaunch: boolEnv("REQUIRE_BANKR_LAUNCH", true),
  bankrLaunchesUrl: env("BANKR_LAUNCHES_URL", "https://api.bankr.bot/token-launches"),
  bankrLaunchRefreshMs: numberEnv("BANKR_LAUNCH_REFRESH_MS", 60000),
  enableDexScreener: boolEnv("ENABLE_DEXSCREENER", true),
  telegramBotToken: env("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: env("TELEGRAM_CHAT_ID", ""),
  discordWebhookUrl: env("DISCORD_WEBHOOK_URL", ""),
  pollIntervalMs: numberEnv("POLL_INTERVAL_MS", 12000),
  confirmations: numberEnv("CONFIRMATIONS", 2),
  blockChunkSize: numberEnv("BLOCK_CHUNK_SIZE", 150),
  stateFile: env("STATE_FILE", ".bot-state.json"),
  scanOnceFromBlock: numberEnv("SCAN_ONCE_FROM_BLOCK", 0),
  scanOnceToBlock: numberEnv("SCAN_ONCE_TO_BLOCK", 0)
};

const tokenCache = new Map<Address, TokenInfo>();

if (!config.telegramBotToken && !config.discordWebhookUrl) {
  console.warn("No alert destination configured. Add Telegram or Discord settings in .env.");
}

console.log("Dynamic Base fee-claim alert bot started.");
console.log(
  config.feeDistributorAddresses.length
    ? `Watching fee distributors: ${config.feeDistributorAddresses.join(", ")}`
    : "Watching Release events from all Base contracts."
);

await main();

async function main(): Promise<void> {
  let state = readState();
  state = await refreshBankrLaunchesIfNeeded(state, true);

  if (config.scanOnceFromBlock && config.scanOnceToBlock) {
    await scanRange(state, config.scanOnceFromBlock, config.scanOnceToBlock);
    console.log("One-shot scan complete.");
    return;
  }

  while (true) {
    try {
      const latest = Number(await rpc<Hex>("eth_blockNumber", []));
      const safeLatest = latest - config.confirmations;

      if (!state.lastScannedBlock) {
        state.lastScannedBlock = safeLatest;
        writeState(state);
        console.log(`Initialized at block ${safeLatest}. Waiting for new blocks.`);
      } else if (safeLatest > state.lastScannedBlock) {
        state = await scanRange(state, state.lastScannedBlock + 1, safeLatest);
      }
    } catch (error) {
      console.error("Scan error:", getErrorMessage(error));
    }

    await sleep(config.pollIntervalMs);
  }
}

async function scanRange(state: State, fromBlock: number, toBlock: number): Promise<State> {
  state = await refreshBankrLaunchesIfNeeded(state);

  for (let start = fromBlock; start <= toBlock; start += config.blockChunkSize) {
    const end = Math.min(start + config.blockChunkSize - 1, toBlock);
    const releaseLogs = await getReleaseLogs(start, end);
    const byTx = groupBy(releaseLogs, (log) => log.transactionHash);

    for (const [txHash, logs] of byTx.entries()) {
      if (state.alertedTxs.includes(txHash)) continue;

      const receipt = await rpc<RpcReceipt>("eth_getTransactionReceipt", [txHash]);
      const releases = logs.map(parseReleaseLog).filter((release) => release !== null);
      const claim = await buildClaim(receipt, releases);

      if (claim.releases.length > 0 && claimMeetsMinimums(claim) && claimPassesBankrFilter(claim, state)) {
        await sendClaimAlert(txHash as Hex, claim);
        state.alertedTxs.push(txHash);
        state.alertedTxs = state.alertedTxs.slice(-1000);
      }
    }

    state.lastScannedBlock = end;
    writeState(state);
    console.log(`Scanned blocks ${start}-${end}, found ${releaseLogs.length} Release event(s).`);
  }

  return state;
}

async function getReleaseLogs(fromBlock: number, toBlock: number): Promise<RpcLog[]> {
  return rpc<RpcLog[]>("eth_getLogs", [
    {
      fromBlock: toHex(fromBlock),
      toBlock: toHex(toBlock),
      address: config.feeDistributorAddresses.length ? config.feeDistributorAddresses : undefined,
      topics: [RELEASE_TOPIC]
    }
  ]);
}

function parseReleaseLog(log: RpcLog): Release | null {
  if (log.topics[0]?.toLowerCase() !== RELEASE_TOPIC || log.topics.length < 3) return null;

  const [fees0, fees1] = decodeTwoUint256(log.data);
  if (fees0 < config.minRawClaimAmount && fees1 < config.minRawClaimAmount) return null;

  return {
    contract: normalizeAddress(log.address),
    poolId: log.topics[1],
    beneficiary: topicToAddress(log.topics[2]),
    fees0,
    fees1,
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash
  };
}

async function buildClaim(
  receipt: RpcReceipt,
  releases: Release[]
): Promise<ClaimSummary> {
  const keptReleases = releases.filter((release) => release.fees0 > 0n || release.fees1 > 0n);
  const collects = receipt.logs.map(parseCollectLog).filter((collect) => collect !== null);
  const releasedTransfers: Transfer[] = [];
  const collectedTransfers: Transfer[] = [];

  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;

    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const rawAmount = BigInt(log.data);
    const release = keptReleases.find(
      (release) =>
        release.beneficiary === to &&
        release.contract === from &&
        (release.fees0 === rawAmount || release.fees1 === rawAmount)
    );
    const collect = collects.find(
      (collect) =>
        collect.contract === to &&
        (collect.fees0 === rawAmount || collect.fees1 === rawAmount) &&
        keptReleases.some((release) => release.contract === collect.contract && release.poolId === collect.poolId)
    );

    if (!release && !collect) continue;

    const token = await getTokenInfo(normalizeAddress(log.address));
    const transfer = {
      token,
      from,
      to,
      rawAmount,
      amount: formatUnits(rawAmount, token.decimals)
    };

    if (release) releasedTransfers.push(transfer);
    if (collect) collectedTransfers.push(transfer);
  }

  return {
    releases: releasedTransfers.length ? keptReleases : [],
    releasedTransfers,
    collectedTransfers
  };
}

function parseCollectLog(log: RpcLog): Collect | null {
  if (log.topics[0]?.toLowerCase() !== COLLECT_TOPIC || log.topics.length < 2) return null;

  const [fees0, fees1] = decodeTwoUint256(log.data);
  return {
    contract: normalizeAddress(log.address),
    poolId: log.topics[1],
    fees0,
    fees1
  };
}

async function getTokenInfo(address: Address): Promise<TokenInfo> {
  const cached = tokenCache.get(address);
  if (cached) return cached;

  const [symbol, decimals] = await Promise.all([
    readTokenSymbol(address).catch(() => shortAddress(address)),
    readTokenDecimals(address).catch(() => 18)
  ]);

  const info = { address, symbol, decimals };
  tokenCache.set(address, info);
  return info;
}

async function readTokenSymbol(address: Address): Promise<string> {
  const result = await ethCall(address, SYMBOL_SELECTOR);
  const dynamic = decodeAbiString(result);
  if (dynamic) return dynamic;

  const bytes32 = hexToAscii(result);
  return bytes32 || shortAddress(address);
}

async function readTokenDecimals(address: Address): Promise<number> {
  const result = await ethCall(address, DECIMALS_SELECTOR);
  return Number(BigInt(result));
}

async function ethCall(to: Address, data: Hex): Promise<Hex> {
  return rpc<Hex>("eth_call", [{ to, data }, "latest"]);
}

async function sendClaimAlert(txHash: Hex, claim: ClaimSummary): Promise<void> {
  const { releases, releasedTransfers, collectedTransfers, bankrLaunch } = claim;
  const beneficiaries = unique(releases.map((release) => release.beneficiary));
  const beneficiary = beneficiaries[0] ?? ("0x0000000000000000000000000000000000000000" as Address);
  const releasedEth = findEthTransfer(releasedTransfers);
  const releasedToken = findProjectTokenTransfer(releasedTransfers);
  const collectedEth = findEthTransfer(collectedTransfers);
  const collectedToken = releasedToken
    ? collectedTransfers.find((transfer) => transfer.token.address === releasedToken.token.address)
    : findProjectTokenTransfer(collectedTransfers);
  const market = releasedToken
    ? await getMarketInfo(releasedToken.token).catch(() => fallbackMarketInfo(releasedToken.token))
    : null;

  const message = [
    "🎉 NEW BANKR FEE CLAIMED!",
    "",
    "Token Information:",
    `• Name: ${bankrLaunch?.tokenName ?? market?.name ?? "Unknown"}`,
    `• Symbol: ${bankrLaunch?.tokenSymbol ?? market?.symbol ?? releasedToken?.token.symbol ?? "Unknown"}`,
    `• Contract: ${releasedToken?.token.address ?? "Unknown"}`,
    `• Market Cap: ${formatUsdCompact(market?.marketCapUsd ?? null)}`,
    `• Liquidity: ${formatUsdCompact(market?.liquidityUsd ?? null)}`,
    "",
    "Released to Beneficiary:",
    `• Token Amount: ${formatTokenLine(releasedToken)}`,
    `• ETH Amount: ${formatEthLine(releasedEth)}`,
    `• Beneficiary: ${shortAddress(beneficiary)}`,
    `• Full Address: ${beneficiary}`,
    "",
    "Total Collected from Pool:",
    `• Token Amount: ${formatTokenLine(collectedToken)}`,
    `• ETH Amount: ${formatEthLine(collectedEth)}`,
    "",
    `https://basescan.org/tx/${txHash}`
  ].join("\n");

  console.log(message);

  await Promise.all([
    config.telegramBotToken && config.telegramChatId ? sendTelegram(message) : Promise.resolve(),
    config.discordWebhookUrl ? sendDiscord(message) : Promise.resolve()
  ]);
}

function claimMeetsMinimums(claim: ClaimSummary): boolean {
  const releasedEth = findEthTransfer(claim.releasedTransfers);
  return releasedEth !== undefined && releasedEth.rawAmount >= config.minEthClaimWei;
}

function claimPassesBankrFilter(claim: ClaimSummary, state: State): boolean {
  if (!config.requireBankrLaunch) return true;

  const releasedToken = findProjectTokenTransfer(claim.releasedTransfers);
  if (!releasedToken) return false;

  const bankrLaunch = state.bankrLaunches[releasedToken.token.address];
  if (!bankrLaunch) return false;

  claim.bankrLaunch = bankrLaunch;
  return true;
}

async function refreshBankrLaunchesIfNeeded(state: State, force = false): Promise<State> {
  if (!config.requireBankrLaunch) return state;

  const now = Date.now();
  if (!force && now - state.lastBankrLaunchRefreshAt < config.bankrLaunchRefreshMs) {
    return state;
  }

  try {
    const launches = await fetchBankrLaunches();
    for (const launch of launches) {
      if (launch.chain.toLowerCase() !== "base") continue;
      state.bankrLaunches[launch.tokenAddress] = launch;
    }
    state.lastBankrLaunchRefreshAt = now;
    writeState(state);
    console.log(`Refreshed Bankr launch cache: ${launches.length} recent launch(es), ${Object.keys(state.bankrLaunches).length} cached token(s).`);
  } catch (error) {
    console.error("Bankr launch refresh error:", getErrorMessage(error));
  }

  return state;
}

async function fetchBankrLaunches(): Promise<BankrLaunch[]> {
  const response = await fetch(config.bankrLaunchesUrl);
  if (!response.ok) {
    throw new Error(`Bankr launches failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    launches?: Array<{
      tokenAddress?: string;
      tokenName?: string;
      tokenSymbol?: string;
      chain?: string;
      launchType?: string;
      poolId?: string;
      txHash?: string;
      timestamp?: number;
      deployer?: { walletAddress?: string; xUsername?: string };
      feeRecipient?: { walletAddress?: string; xUsername?: string };
      tweetUrl?: string;
      websiteUrl?: string;
    }>;
  };

  return (body.launches ?? [])
    .filter((launch) => launch.tokenAddress && launch.tokenName && launch.tokenSymbol && launch.chain)
    .map((launch) => ({
      tokenAddress: normalizeAddress(launch.tokenAddress ?? ""),
      tokenName: launch.tokenName ?? "",
      tokenSymbol: launch.tokenSymbol ?? "",
      chain: launch.chain ?? "",
      launchType: launch.launchType,
      poolId: launch.poolId as Hex | undefined,
      txHash: launch.txHash as Hex | undefined,
      timestamp: launch.timestamp,
      deployer: launch.deployer
        ? {
            walletAddress: launch.deployer.walletAddress ? normalizeAddress(launch.deployer.walletAddress) : undefined,
            xUsername: launch.deployer.xUsername
          }
        : undefined,
      feeRecipient: launch.feeRecipient
        ? {
            walletAddress: launch.feeRecipient.walletAddress ? normalizeAddress(launch.feeRecipient.walletAddress) : undefined,
            xUsername: launch.feeRecipient.xUsername
          }
        : undefined,
      tweetUrl: launch.tweetUrl,
      websiteUrl: launch.websiteUrl
    }));
}

function findEthTransfer(transfers: Transfer[]): Transfer | undefined {
  return transfers.find((transfer) => transfer.token.address === BASE_WETH_ADDRESS);
}

function findProjectTokenTransfer(transfers: Transfer[]): Transfer | undefined {
  const nonEth = transfers.filter((transfer) => transfer.token.address !== BASE_WETH_ADDRESS);
  return nonEth.sort((a, b) => compareBigIntDesc(a.rawAmount, b.rawAmount))[0];
}

function compareBigIntDesc(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

async function getMarketInfo(token: TokenInfo): Promise<MarketInfo> {
  if (!config.enableDexScreener) return fallbackMarketInfo(token);

  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${token.address}`);
  if (!response.ok) {
    throw new Error(`DexScreener failed: ${response.status} ${await response.text()}`);
  }

  const pairs = (await response.json()) as Array<{
    baseToken?: { address?: string; name?: string; symbol?: string };
    quoteToken?: { address?: string; name?: string; symbol?: string };
    liquidity?: { usd?: number };
    marketCap?: number;
    fdv?: number;
  }>;
  const best = pairs
    .filter((pair) => pair.baseToken?.address?.toLowerCase() === token.address || pair.quoteToken?.address?.toLowerCase() === token.address)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  if (!best) return fallbackMarketInfo(token);

  const tokenSide =
    best.baseToken?.address?.toLowerCase() === token.address ? best.baseToken : best.quoteToken;

  return {
    name: tokenSide?.name ?? token.symbol,
    symbol: tokenSide?.symbol ?? token.symbol,
    marketCapUsd: best.marketCap ?? best.fdv ?? null,
    liquidityUsd: best.liquidity?.usd ?? null
  };
}

function fallbackMarketInfo(token: TokenInfo): MarketInfo {
  return {
    name: token.symbol,
    symbol: token.symbol,
    marketCapUsd: null,
    liquidityUsd: null
  };
}

function formatTokenLine(transfer: Transfer | undefined): string {
  if (!transfer) return "Unknown";
  return `${formatNumberString(transfer.amount)} ${transfer.token.symbol}`;
}

function formatEthLine(transfer: Transfer | undefined): string {
  if (!transfer) return "Unknown";
  return `${formatNumberString(transfer.amount)} ETH`;
}

function formatNumberString(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmedFraction ? `${grouped}.${trimmedFraction}` : grouped;
}

function formatUsdCompact(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "Unknown";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

async function sendTelegram(text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram failed: ${response.status} ${await response.text()}`);
  }
}

async function sendDiscord(content: string): Promise<void> {
  const response = await fetch(config.discordWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    throw new Error(`Discord failed: ${response.status} ${await response.text()}`);
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) {
    throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error(`RPC ${method} returned no result`);
  }
  return body.result;
}

function readState(): State {
  const statePath = path.resolve(config.stateFile);
  if (!fs.existsSync(statePath)) {
    return { lastScannedBlock: 0, alertedTxs: [], bankrLaunches: {}, lastBankrLaunchRefreshAt: 0 };
  }

  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<State>;
  return {
    lastScannedBlock: state.lastScannedBlock ?? 0,
    alertedTxs: state.alertedTxs ?? [],
    bankrLaunches: state.bankrLaunches ?? {},
    lastBankrLaunchRefreshAt: state.lastBankrLaunchRefreshAt ?? 0
  };
}

function writeState(state: State): void {
  fs.writeFileSync(path.resolve(config.stateFile), `${JSON.stringify(state, null, 2)}\n`);
}

function loadDotEnv(): void {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function addressListEnv(name: string): Address[] {
  return env(name, "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean)
    .map(normalizeAddress);
}

function normalizeAddress(value: string): Address {
  const address = value.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error(`Invalid address: ${value}`);
  }
  return address as Address;
}

function topicToAddress(topic: Hex): Address {
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function toHex(number: number): Hex {
  return `0x${number.toString(16)}`;
}

function decodeTwoUint256(data: Hex): [bigint, bigint] {
  const clean = data.slice(2).padStart(128, "0");
  return [BigInt(`0x${clean.slice(0, 64)}`), BigInt(`0x${clean.slice(64, 128)}`)];
}

function decodeAbiString(data: Hex): string {
  const clean = data.slice(2);
  if (clean.length < 128) return "";

  const offset = Number(BigInt(`0x${clean.slice(0, 64)}`));
  const lengthStart = offset * 2;
  const length = Number(BigInt(`0x${clean.slice(lengthStart, lengthStart + 64)}`));
  const valueStart = lengthStart + 64;
  return hexToAscii(`0x${clean.slice(valueStart, valueStart + length * 2)}`);
}

function hexToAscii(data: Hex): string {
  const clean = data.slice(2).replace(/(00)+$/g, "");
  if (!clean) return "";

  const chars: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    chars.push(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return new TextDecoder().decode(new Uint8Array(chars)).replace(/\0/g, "").trim();
}

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionText ? `${whole}.${fractionText.slice(0, 6)}` : whole.toString();
}

function parseUnits(value: string, decimals: number): bigint {
  const [wholePart, fractionPart = ""] = value.trim().split(".");
  const whole = BigInt(wholePart || "0") * 10n ** BigInt(decimals);
  const fraction = BigInt(fractionPart.padEnd(decimals, "0").slice(0, decimals) || "0");
  return whole + fraction;
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
