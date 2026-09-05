// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function chainId(uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function eq(uint256 a, uint256 b) internal pure {
        require(a == b, "uint mismatch");
    }

    function eq(bytes32 a, bytes32 b) internal pure {
        require(a == b, "hash mismatch");
    }

    function yes(bool a) internal pure {
        require(a, "expected true");
    }

    function no(bool a) internal pure {
        require(!a, "expected false");
    }
}
