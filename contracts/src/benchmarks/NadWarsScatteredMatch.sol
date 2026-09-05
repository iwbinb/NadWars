// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {NadWarsMatch} from "../NadWarsMatch.sol";

/// @notice Benchmark-only layout; identical game transitions with hash-scattered cell words.
contract NadWarsScatteredMatch is NadWarsMatch {
    constructor(bytes32 id) NadWarsMatch(id) {}

    function _cellSlot(uint8 zone, uint8 tile) internal pure override returns (uint256) {
        return uint256(keccak256(abi.encode("nadwars.scattered.standard.v0.2", zone, tile)));
    }
}
