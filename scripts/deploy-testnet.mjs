import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { writeFile } from "node:fs/promises";
import { artifacts, detectMode } from "../src/chain/verify.js";

// This command is a dry run unless --broadcast is explicitly supplied.
const broadcast = process.argv.includes("--broadcast"),
  rpc = process.env.MONAD_RPC_URL || "https://rpc-testnet.monadinfra.com";
const mode = process.env.NADWARS_MODE || "standard",
  artifact = artifacts[mode];
if (!artifact) throw new Error("Unknown game mode");
if (!process.env.DEPLOYER_PRIVATE_KEY)
  throw new Error(
    "Load DEPLOYER_PRIVATE_KEY from a private environment file. Never put it in a VITE_* variable.",
  );
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
  testnet: true,
});
const client = createPublicClient({ chain, transport: http(rpc) }),
  wallet = createWalletClient({ account, chain, transport: http(rpc) });
if ((await client.getChainId()) !== 10143)
  throw new Error("Refusing a deployment outside Monad Testnet 10143");
const matchId = keccak256(crypto.getRandomValues(new Uint8Array(32)));
const { encodeDeployData } = await import("viem");
const data = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [matchId],
});
const gas = await client.estimateGas({
    account: account.address,
    data,
    blockTag: "latest",
  }),
  gasPrice = await client.getGasPrice(),
  limit = (gas * 11n) / 10n,
  balance = await client.getBalance({ address: account.address });
const prepared = {
  mode,
  chainId: 10143,
  deployer: account.address,
  matchId,
  gasEstimate: gas.toString(),
  gasLimit: limit.toString(),
  gasPriceWei: gasPrice.toString(),
  maximumGasCostWei: (limit * gasPrice).toString(),
  balanceWei: balance.toString(),
  broadcast,
};
console.log(JSON.stringify(prepared, null, 2));
if (!broadcast) process.exit(0);
if (balance < limit * gasPrice)
  throw new Error("Insufficient test MON for the prepared gas budget");
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [matchId],
  gas: limit,
  gasPrice,
  type: "legacy",
});
console.log(JSON.stringify({ submittedHash: hash }));
const receipt = await client.waitForTransactionReceipt({
  hash,
  timeout: 120000,
});
if (receipt.status !== "success" || !receipt.contractAddress)
  throw new Error("Deployment was not successful");
if (
  detectMode(await client.getCode({ address: receipt.contractAddress })) !==
  mode
)
  throw new Error("Deployed runtime does not match the client artifact");
let finalized = false;
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const block = await client
    .getBlock({ blockTag: "finalized" })
    .catch(() => null);
  if (block && block.number >= receipt.blockNumber) {
    finalized = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const result = {
  ...prepared,
  address: receipt.contractAddress,
  hash,
  block: receipt.blockNumber.toString(),
  executionConfirmed: true,
  finalized,
};
if (process.env.DEPLOYMENT_OUTPUT)
  await writeFile(
    process.env.DEPLOYMENT_OUTPUT,
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
console.log(JSON.stringify(result, null, 2));
