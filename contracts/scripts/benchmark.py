#!/usr/bin/env python3
"""Run identical cold-transaction scenarios against local Anvil only.

Requires compiled Forge artifacts. Uses unlocked *local test* accounts and restores
its snapshot afterward. Rejects remote RPCs and non-31337 chains by construction.
"""
import argparse
import hashlib
import json
import math
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
GAS_PRICE = 100_000_000_000
SCENARIO = [
    (0, 0, 0, 23, 2, "build-relay"),
    (1, 1, 0, 25, 2, "build-opponent-relay"),
    (2, 0, 0, 24, 3, "capture-objective"),
    (4, 1, 1, 24, 0, "attack-objective"),
    (6, 0, 2, 24, 0, "repair-objective"),
    (8, 0, 2, 24, 0, "repair-clamped"),
    (10, 1, 0, 18, 2, "build-flanking-relay"),
    (12, 1, 0, 17, 2, "extend-flank"),
    (14, 1, 1, 23, 0, "attack-supply-1"),
    (16, 1, 1, 23, 0, "attack-supply-2"),
    (18, 1, 1, 23, 0, "cut-supply"),
    (20, 0, 0, 29, 2, "build-alternative-1"),
    (22, 0, 0, 30, 2, "restore-power"),
    (24, 0, 0, 31, 4, "build-turret"),
    (26, 1, 0, 19, 5, "build-shield"),
    (28, 1, 1, 24, 0, "attack-after-reconnection"),
    (30, 0, 2, 24, 0, "repair-after-reconnection"),
    (32, 0, 2, 24, 0, "repair-to-full"),
    (34, 0, 1, 25, 0, "attack-turret-vs-shield"),
]


def words(data):
    raw = data.removeprefix("0x")
    return [int(raw[i:i + 64], 16) for i in range(0, len(raw), 64)]


class Rpc:
    def __init__(self, url):
        parsed = urlparse(url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("Benchmark is restricted to a loopback HTTP Anvil RPC")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("RPC credentials and URL parameters are not supported")
        self.url, self.id = url, 0

    def call(self, method, params=None):
        self.id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params or []}).encode()
        req = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.load(response)
        if "error" in payload:
            raise RuntimeError(f"{method}: {payload['error']}")
        return payload["result"]


def artifact(name):
    return json.loads((ROOT / "out" / f"{name}.sol" / f"{name}.json").read_text())


def calldata(art, signature, *args):
    return "0x" + art["methodIdentifiers"][signature] + "".join(
        f"{int(x, 16) if isinstance(x, str) else x:064x}" for x in args
    )


def source_manifest():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / "src").rglob("*.sol"))}


def run_layout(rpc, name):
    art = artifact(name)
    accounts = rpc.call("eth_accounts")
    if len(accounts) < 3:
        raise RuntimeError("Need three unlocked local test accounts")
    creator, alice, bob = accounts[:3]
    genesis = int(rpc.call("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
    rows = []

    def send(label, sender, data, at, to=None):
        # Time changes are shared by both variants, including estimate/simulation.
        rpc.call("evm_setNextBlockTimestamp", [at])
        rpc.call("evm_mine")
        tx = {"from": sender, "data": data, "gasPrice": hex(GAS_PRICE)}
        if to:
            tx["to"] = to
        estimated = int(rpc.call("eth_estimateGas", [tx]), 16)
        limit = math.ceil(estimated * 1.1)
        tx["gas"] = hex(limit)
        balance_before = int(rpc.call("eth_getBalance", [sender, "latest"]), 16)
        tx_hash = rpc.call("eth_sendTransaction", [tx])
        receipt = None
        for _ in range(100):
            receipt = rpc.call("eth_getTransactionReceipt", [tx_hash])
            if receipt:
                break
            time.sleep(0.01)
        if receipt is None or int(receipt["status"], 16) != 1:
            raise RuntimeError(f"{label} failed: {receipt}")
        balance_after = int(rpc.call("eth_getBalance", [sender, "latest"]), 16)
        block = rpc.call("eth_getBlockByHash", [receipt["blockHash"], False])
        if int(block["timestamp"], 16) != at:
            raise RuntimeError(f"Unexpected block time for {label}: {block['timestamp']} != {at}")
        rows.append({"label": label, "gas_estimate": estimated, "gas_limit": limit,
                     "receipt_gas_used": int(receipt["gasUsed"], 16),
                     "effective_gas_price_wei": int(receipt["effectiveGasPrice"], 16),
                     "balance_delta_wei": str(balance_before - balance_after),
                     "tx_hash": tx_hash, "block_number": int(receipt["blockNumber"], 16),
                     "timestamp": at})
        return receipt

    deployment = send("deploy", creator, art["bytecode"]["object"] + bytes.fromhex("01" * 32).hex(), genesis + 1)
    address = deployment["contractAddress"]

    def read(signature, *args):
        return rpc.call("eth_call", [{"to": address, "data": calldata(art, signature, *args)}, "latest"])

    send("join-purple", alice, calldata(art, "join(uint8)", 1), genesis + 2, address)
    send("join-amber", bob, calldata(art, "join(uint8)", 2), genesis + 3, address)
    roster = words(read("rosterVersion()"))[0]
    rule_hash = read("RULES_HASH()")
    send("ready-purple", alice, calldata(art, "setReady(uint32,bytes32)", roster, rule_hash), genesis + 4, address)
    send("ready-amber", bob, calldata(art, "setReady(uint32,bytes32)", roster, rule_hash), genesis + 5, address)
    send("start", creator, calldata(art, "start()"), genesis + 6, address)
    start_at = words(read("startAt()"))[0]
    duration = words(read("DURATION()"))[0]
    snapshots = []
    nonces = [0, 0]
    for offset, player, action, tile, kind, label in SCENARIO:
        send(label, [alice, bob][player], calldata(art, "act(uint8,uint8,uint8,uint64)", action, tile, kind, nonces[player]), start_at + offset, address)
        nonces[player] += 1
        snapshots.append({"label": label, "board": read("board()"), "power1": read("power1()"),
                          "power2": read("power2()"), "scores": read("scores()"),
                          "alice": read("playerState(address)", alice), "bob": read("playerState(address)", bob)})
        if label == "cut-supply" and words(read("cell(uint8)", 24))[3] != 0:
            raise AssertionError("Supply cut did not turn objective off")
        if label == "restore-power" and words(read("cell(uint8)", 24))[3] != 1:
            raise AssertionError("Alternative route did not restore power")
    send("finalize", creator, calldata(art, "finalize()"), start_at + duration, address)
    final_scores = words(read("scores()"))
    if final_scores != [duration - 6, 0]:
        raise AssertionError(f"Score mismatch: expected [{duration - 6}, 0], got {final_scores}")
    final_board_hash = read("boardHash()")
    send("finalize-again", creator, calldata(art, "finalize()"), start_at + duration + 1, address)
    assert words(read("scores()")) == final_scores
    return {"contract": name, "address_local_only": address, "rows": rows,
            "final_scores": final_scores, "final_board_hash": final_board_hash,
            "snapshots": snapshots, "rules_hash": rule_hash}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", default="http://127.0.0.1:18547")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rpc = Rpc(args.rpc)
    if int(rpc.call("eth_chainId"), 16) != 31337:
        raise ValueError("Refusing transactions outside local chain 31337")
    info = rpc.call("anvil_nodeInfo")
    if info.get("forkConfig", {}).get("forkUrl"):
        raise ValueError("Use a fresh local chain, not a fork")
    if info.get("network") == "monad" and info.get("hardFork") != "MonadTen":
        raise ValueError("Monad measurement requires MonadTen")
    # Freeze wall-clock progression so paired runs execute at identical timestamps.
    rpc.call("anvil_setBlockTimestampInterval", [0])
    root_snapshot = rpc.call("evm_snapshot")
    results = []
    try:
        for name in ("NadWarsSingleZone", "NadWarsScatteredZone"):
            snapshot = rpc.call("evm_snapshot")
            try:
                results.append(run_layout(rpc, name))
            finally:
                if not rpc.call("evm_revert", [snapshot]):
                    raise RuntimeError("Could not restore per-layout snapshot")
        packed, scattered = results
        assert packed["snapshots"] == scattered["snapshots"], "Game states diverged between layouts"
        assert packed["final_board_hash"] == scattered["final_board_hash"]
        comparisons = []
        for p, s in zip(packed["rows"], scattered["rows"]):
            assert p["label"] == s["label"]
            diff = s["receipt_gas_used"] - p["receipt_gas_used"]
            comparisons.append({"action": p["label"], "page_gas": p["receipt_gas_used"],
                                "scattered_gas": s["receipt_gas_used"], "gas_saved": diff,
                                "saved_percent": round(100 * diff / s["receipt_gas_used"], 2)})
        # Full snapshots are retained as reproducible evidence, not game telemetry claims.
        metadata = artifact("NadWarsSingleZone")["metadata"]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        report = {"schema": 1, "measured_at_utc": datetime.now(timezone.utc).isoformat(),
                  "environment": info, "client": rpc.call("web3_clientVersion"),
                  "compiler": metadata["compiler"], "compiler_settings": metadata["settings"],
                  "config_sha256": hashlib.sha256((ROOT / "foundry.toml").read_bytes()).hexdigest(),
                  "benchmark_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "bytecode_sha256": {name: hashlib.sha256(bytes.fromhex(artifact(name)["bytecode"]["object"].removeprefix("0x"))).hexdigest()
                                      for name in ("NadWarsSingleZone", "NadWarsScatteredZone")},
                  "scope": "LOCAL execution gas and isolated transaction receipts; NOT public-testnet latency or parallel throughput",
                  "gas_limit_policy": "ceil(eth_estimateGas * 1.10), same policy for both layouts",
                  "gas_price_wei": GAS_PRICE, "source_sha256": source_manifest(),
                  "same_state_after_every_action": True, "scenario_actions": len(SCENARIO),
                  "comparisons": comparisons, "runs": results}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"output": str(args.output), "network": info.get("network"), "hardfork": info.get("hardFork"),
                          "same_state": True, "final_scores": packed["final_scores"], "comparisons": comparisons}, indent=2))
    finally:
        rpc.call("evm_revert", [root_snapshot])


if __name__ == "__main__":
    main()
