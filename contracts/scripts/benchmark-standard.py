#!/usr/bin/env python3
"""Eight local accounts, four zones, identical traces for aligned and scattered layouts.

Time is controlled for gas equivalence; this is not a network latency/TPS test.
Never accepts a remote RPC or a funded public-network wallet.
"""
import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path
from benchmark import Rpc, artifact, calldata, words, SCENARIO, GAS_PRICE, source_manifest


def run(rpc, name):
    art = artifact(name)
    accounts = rpc.call("eth_accounts")
    creator, users = accounts[0], accounts[1:9]
    if len(users) != 8:
        raise RuntimeError("Eight local accounts required")
    genesis = words(rpc.call("eth_getBlockByNumber", ["latest", False])["timestamp"])[0]
    rows, states, nonces = [], [], [0] * 8

    def send(label, sender, data, at, address=None):
        rpc.call("evm_setNextBlockTimestamp", [at])
        rpc.call("evm_mine")
        tx = {"from": sender, "data": data, "gasPrice": hex(GAS_PRICE)}
        if address:
            tx["to"] = address
        estimate = int(rpc.call("eth_estimateGas", [tx]), 16)
        tx["gas"] = hex(math.ceil(estimate * 1.1))
        before = int(rpc.call("eth_getBalance", [sender, "latest"]), 16)
        txhash = rpc.call("eth_sendTransaction", [tx])
        for _ in range(200):
            receipt = rpc.call("eth_getTransactionReceipt", [txhash])
            if receipt:
                break
            time.sleep(.01)
        if not receipt or int(receipt["status"], 16) != 1:
            raise RuntimeError(f"{label} failed")
        after = int(rpc.call("eth_getBalance", [sender, "latest"]), 16)
        block = rpc.call("eth_getBlockByHash", [receipt["blockHash"], False])
        assert int(block["timestamp"], 16) == at
        rows.append({"label": label, "sender": sender, "hash": txhash, "timestamp": at,
                     "gas_estimate": estimate, "gas_limit": int(tx["gas"], 16),
                     "receipt_gas_used": int(receipt["gasUsed"], 16),
                     "balance_delta_wei": str(before-after),
                     "effective_gas_price_wei": int(receipt["effectiveGasPrice"], 16)})
        return receipt

    deployed = send("deploy", creator, art["bytecode"]["object"] + "02" * 32, genesis+1)
    address = deployed["contractAddress"]

    def read(signature, *args):
        return rpc.call("eth_call", [{"to": address, "data": calldata(art, signature, *args)}, "latest"])

    for i, user in enumerate(users):
        send(f"join-{i}", user, calldata(art, "join(uint8)", 1 if i < 4 else 2), genesis+2, address)
    roster, rules = words(read("rosterVersion()"))[0], read("RULES_HASH()")
    for i, user in enumerate(users):
        send(f"ready-{i}", user, calldata(art, "setReady(uint32,bytes32)", roster, rules), genesis+3, address)
    send("start", creator, calldata(art, "start()"), genesis+4, address)
    start = words(read("startAt()"))[0]
    duration = words(read("DURATION()"))[0]

    def act(offset, user, action, zone, tile, kind, label):
        send(label, users[user], calldata(art, "act(uint8,uint8,uint8,uint8,uint64)", action, zone, tile, kind, nonces[user]), start+offset, address)
        nonces[user] += 1
        states.append({"label": label, "zones": [read("zoneState(uint8)", z) for z in range(4)],
                       "players": [read("playerState(address)", u) for u in users], "scores": read("scores()")})

    for offset, player, action, tile, kind, label in SCENARIO:
        for zone in range(4):
            act(offset, player*4+zone, action, zone, tile, kind, f"action-z{zone}-{label}")
    act(36, 0, 3, 1, 0, 0, "action-support-purple-0-to-1")
    act(36, 4, 3, 2, 0, 0, "action-support-amber-0-to-2")
    act(41, 0, 1, 1, 25, 0, "action-arrived-attack")
    act(41, 4, 2, 2, 25, 0, "action-arrived-ally-repair")
    send("finalize", creator, calldata(art, "finalize()"), start+duration, address)
    scores = words(read("scores()"))
    assert scores == [4 * (duration - 6), 0], scores
    return {"layout": name, "contract": address, "rules_hash": rules, "scores": scores,
            "board_hash": read("boardHash()"), "rows": rows, "states": states}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    rpc = Rpc(args.rpc)
    if int(rpc.call("eth_chainId"), 16) != 31337:
        raise ValueError("Only chain 31337 is allowed")
    info = rpc.call("anvil_nodeInfo")
    if info.get("forkConfig", {}).get("forkUrl"):
        raise ValueError("Forked chains are not allowed")
    if info["network"] == "monad" and info["hardFork"] != "MonadTen":
        raise ValueError("Expected MonadTen")
    rpc.call("anvil_setBlockTimestampInterval", [0])
    results = []
    for name in ["NadWarsMatch", "NadWarsScatteredMatch"]:
        checkpoint = rpc.call("evm_snapshot")
        try:
            results.append(run(rpc, name))
        finally:
            assert rpc.call("evm_revert", [checkpoint])
    assert results[0]["states"] == results[1]["states"], "State traces diverged"
    assert results[0]["board_hash"] == results[1]["board_hash"]
    gas = [sum(r["receipt_gas_used"] for r in x["rows"] if r["label"].startswith("action-")) for x in results]
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "environment": info,
              "kind": "controlled-time gas comparison; not network throughput", "sources": source_manifest(),
              "action_count_per_layout": 80, "state_equality": True, "aligned_gas": gas[0], "scattered_gas": gas[1],
              "saving_percent": (gas[1]-gas[0])/gas[1]*100, "layouts": results}
    args.output.write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({k: report[k] for k in ["action_count_per_layout", "state_equality", "aligned_gas", "scattered_gas", "saving_percent"]}))


if __name__ == "__main__":
    main()
