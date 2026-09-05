import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundedJSON,
  validatedRPC,
  relayInput,
  rpcURL,
  chainFor,
} from "../cloudflare/protocol.ts";

test("RPC proxy denies node administration and bounds historical queries", () => {
  for (const method of [
    "anvil_setBalance",
    "eth_sendTransaction",
    "anvil_impersonateAccount",
    "debug_traceTransaction",
  ])
    assert.throws(() => validatedRPC({ method, params: [] }), /不允许/);
  assert.throws(
    () =>
      validatedRPC(
        Array.from({ length: 21 }, () => ({
          method: "eth_chainId",
          params: [],
        })),
      ),
    /批次/,
  );
  assert.throws(
    () =>
      validatedRPC({
        method: "eth_getLogs",
        params: [
          {
            address: "0x" + "11".repeat(20),
            fromBlock: "0x0",
            toBlock: "0x200",
          },
        ],
      }),
    /范围/,
  );
  assert.throws(
    () =>
      validatedRPC({
        method: "eth_getBlockByNumber",
        params: ["latest", true],
      }),
    /完整区块/,
  );
  assert.equal(
    validatedRPC({
      method: "eth_call",
      params: [{ to: "0x" + "11".repeat(20), data: "0x" }, "latest"],
    }).length,
    1,
  );
});
test("request bodies are bounded while streaming", async () => {
  await assert.rejects(
    () => boundedJSON(new Response("x".repeat(101)), 100),
    /过大/,
  );
  await assert.rejects(() => boundedJSON(new Response("{oops")), /JSON/);
  assert.deepEqual(await boundedJSON(new Response('{"ok":true}')), {
    ok: true,
  });
});
test("relay rejects malformed signatures and out-of-range support destinations", () => {
  const input = {
    address: "0x" + "11".repeat(20),
    signature: "0x" + "22".repeat(65),
    action: {
      player: "0x" + "33".repeat(20),
      nonce: "0",
      deadline: "100",
      sessionVersion: 1,
      action: 3,
      zone: 1,
      tile: 0,
      kind: 0,
    },
  };
  assert.equal(relayInput(input).action.zone, 1);
  assert.throws(() => relayInput({ ...input, signature: "0x" }), /签名/);
  assert.throws(
    () => relayInput({ ...input, action: { ...input.action, zone: 4 } }),
    /范围/,
  );
  assert.throws(
    () => relayInput({ ...input, action: { ...input.action, nonce: "-1" } }),
    /签名/,
  );
});
test("production network cannot be repointed to local or insecure RPC", () => {
  const env = {
    NETWORK: "testnet",
    PUBLIC_RPC_URL: "https://testnet-rpc.monad.xyz",
  };
  assert.equal(chainFor(env).id, 10143);
  assert.throws(
    () => rpcURL({ ...env, PUBLIC_RPC_URL: "http://127.0.0.1:18547" }),
    /配置/,
  );
  assert.equal(
    chainFor({
      ...env,
      NETWORK: "local",
      PUBLIC_RPC_URL: "http://127.0.0.1:18547",
    }).id,
    31337,
  );
});
