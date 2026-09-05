// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The 7x7 axial board shared by both storage implementations.
library HexGrid {
    uint64 internal constant ALL = (uint64(1) << 49) - 1;
    uint64 internal constant LEFT = 0x40810204081;
    uint64 internal constant RIGHT = LEFT << 6;
    uint64 internal constant OBJECTIVES = (uint64(1) << 10) | (uint64(1) << 24) | (uint64(1) << 38);

    function neighbors(uint64 cells) internal pure returns (uint64) {
        return (((cells & ~RIGHT) << 1)
                | ((cells & ~LEFT) >> 1)
                | (cells << 7)
                | (cells >> 7)
                | ((cells & ~RIGHT) >> 6)
                | ((cells & ~LEFT) << 6)) & ALL;
    }

    function adjacent(uint8 a, uint8 b) internal pure returns (bool) {
        return a < 49 && b < 49 && (neighbors(uint64(1) << a) & (uint64(1) << b)) != 0;
    }

    function connected(uint64 occupied, uint8 root) internal pure returns (uint64 reached) {
        uint64 frontier = (uint64(1) << root) & occupied;
        reached = frontier;
        while (frontier != 0) {
            frontier = neighbors(frontier) & occupied & ~reached;
            reached |= frontier;
        }
    }

    function objectives(uint64 power) internal pure returns (uint8) {
        return uint8((power >> 10) & 1) + uint8((power >> 24) & 1) + uint8((power >> 38) & 1);
    }

    function isObjective(uint8 tile) internal pure returns (bool) {
        return tile == 10 || tile == 24 || tile == 38;
    }
}
