// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {NadWarsZoneCore} from "./NadWarsZoneCore.sol";

/// @notice Page-aligned board: 49 words fit inside one Monad 128-slot storage page.
contract NadWarsSingleZone is NadWarsZoneCore {
    uint256 internal constant BOARD_PAGE = uint256(keccak256("nadwars.zone.board.v0.1")) & ~uint256(127);

    constructor(bytes32 id) NadWarsZoneCore(id) {}

    function _cellSlot(uint8 tile) internal pure override returns (uint256) {
        return BOARD_PAGE + tile;
    }
}
