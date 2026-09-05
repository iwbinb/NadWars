// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TestBase} from "./TestBase.sol";
import {HexGrid} from "../src/HexGrid.sol";

contract HexGridTest is TestBase {
    function test_AllAdjacenciesMatchIndependentCoordinates() public pure {
        for (uint8 a; a < 49; ++a) {
            for (uint8 b; b < 49; ++b) {
                int256 dq = int256(uint256(b % 7)) - int256(uint256(a % 7));
                int256 dr = int256(uint256(b / 7)) - int256(uint256(a / 7));
                bool expected = (dq == 1 && dr == 0) || (dq == -1 && dr == 0) || (dq == 0 && dr == 1)
                    || (dq == 0 && dr == -1) || (dq == 1 && dr == -1) || (dq == -1 && dr == 1);
                require(HexGrid.adjacent(a, b) == expected, "coordinate adjacency mismatch");
                require(HexGrid.adjacent(a, b) == HexGrid.adjacent(48 - a, 48 - b), "rotation mismatch");
            }
        }
        no(HexGrid.adjacent(6, 7));
        no(HexGrid.adjacent(49, 0));
        no(HexGrid.adjacent(0, 255));
    }

    function testFuzz_FloodMatchesIndependentBfs(uint64 occupied) public pure {
        occupied &= (uint64(1) << 49) - 1;
        eq(HexGrid.connected(occupied, 21), referencePower(occupied, 21));
        eq(HexGrid.connected(occupied, 27), referencePower(occupied, 27));
    }

    function referencePower(uint64 occupied, uint8 root) internal pure returns (uint64 reached) {
        if ((occupied & (uint64(1) << root)) == 0) return 0;
        uint8[49] memory queue;
        uint256 head;
        uint256 tail = 1;
        queue[0] = root;
        reached = uint64(1) << root;
        while (head < tail) {
            uint8 a = queue[head++];
            for (uint8 b; b < 49; ++b) {
                uint64 bit = uint64(1) << b;
                if ((occupied & bit) == 0 || (reached & bit) != 0) continue;
                int256 dq = int256(uint256(b % 7)) - int256(uint256(a % 7));
                int256 dr = int256(uint256(b / 7)) - int256(uint256(a / 7));
                if (
                    (dq == 1 && dr == 0) || (dq == -1 && dr == 0) || (dq == 0 && dr == 1) || (dq == 0 && dr == -1)
                        || (dq == 1 && dr == -1) || (dq == -1 && dr == 1)
                ) {
                    reached |= bit;
                    queue[tail++] = b;
                }
            }
        }
    }
}
