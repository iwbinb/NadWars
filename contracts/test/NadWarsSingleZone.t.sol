// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TestBase, Vm} from "./TestBase.sol";
import {NadWarsZoneCore as Core} from "../src/NadWarsZoneCore.sol";
import {NadWarsSingleZone} from "../src/NadWarsSingleZone.sol";
import {NadWarsScatteredZone} from "../src/benchmarks/NadWarsScatteredZone.sol";

contract NadWarsSingleZoneTest is TestBase {
    Core internal game;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant OTHER = address(0xCAFE);
    uint256 internal constant SESSION_KEY = 0xBEEF;

    function setUp() public {
        vm.warp(1000);
        game = new NadWarsSingleZone(bytes32("test-match"));
        _start(game);
    }

    function _start(Core g) internal {
        vm.prank(ALICE);
        g.join(1);
        vm.prank(BOB);
        g.join(2);
        uint32 roster = g.rosterVersion();
        bytes32 rules = g.RULES_HASH();
        vm.prank(ALICE);
        g.setReady(roster, rules);
        vm.prank(BOB);
        g.setReady(roster, rules);
        g.start();
        vm.warp(g.startAt());
    }

    function _at(uint256 elapsed) internal {
        vm.warp(uint256(game.startAt()) + elapsed);
    }

    function _act(address who, Core.ActionType a, uint8 tile, Core.Kind k) internal {
        uint64 nonce = game.playerState(who).nonce;
        vm.prank(who);
        game.act(a, tile, k, nonce);
    }

    function _build(address who, uint8 tile, Core.Kind k) internal {
        _act(who, Core.ActionType.Build, tile, k);
    }

    function _attack(address who, uint8 tile) internal {
        _act(who, Core.ActionType.Attack, tile, Core.Kind.Empty);
    }

    function _repair(address who, uint8 tile) internal {
        _act(who, Core.ActionType.Repair, tile, Core.Kind.Empty);
    }

    function _cell(uint8 tile, Core.Kind k, uint8 team, uint16 hp, bool power) internal view {
        (Core.Kind actual, uint8 t, uint16 h, bool p) = game.cell(tile);
        eq(uint8(actual), uint8(k));
        eq(t, team);
        eq(h, hp);
        require(p == power, "power mismatch");
    }

    function _stateHash(Core g) internal view returns (bytes32) {
        (uint16 a, uint16 b) = g.scores();
        return keccak256(
            abi.encode(g.board(), g.power1(), g.power2(), a, b, g.scoreAt(), g.playerState(ALICE), g.playerState(BOB))
        );
    }

    function _reject(address who, Core.ActionType a, uint8 tile, Core.Kind k, bytes4 err) internal {
        bytes32 beforeHash = _stateHash(game);
        uint64 nonce = game.playerState(who).nonce;
        vm.recordLogs();
        vm.expectRevert(err);
        vm.prank(who);
        game.act(a, tile, k, nonce);
        eq(_stateHash(game), beforeHash);
        eq(vm.getRecordedLogs().length, 0);
    }

    function test_InitialMapAndPracticeIdentity() public view {
        _cell(21, Core.Kind.Reactor, 1, 1, true);
        _cell(22, Core.Kind.Relay, 1, 100, true);
        _cell(26, Core.Kind.Relay, 2, 100, true);
        _cell(27, Core.Kind.Reactor, 2, 1, true);
        _cell(10, Core.Kind.Empty, 0, 0, false);
        _cell(24, Core.Kind.Empty, 0, 0, false);
        _cell(38, Core.Kind.Empty, 0, 0, false);
        eq(game.MODE(), keccak256("NadWars:single-zone-practice:v0.1"));
        eq(game.energyOf(ALICE), 100);
        (uint16 a, uint16 b) = game.scores();
        eq(a, 0);
        eq(b, 0);
        eq(game.endAt() - game.startAt(), 60);
    }

    function test_BuildCostsHpNonceAndCooldown() public {
        _build(ALICE, 23, Core.Kind.Relay);
        _cell(23, Core.Kind.Relay, 1, 100, true);
        Core.Player memory p = game.playerState(ALICE);
        eq(p.energy, 85);
        eq(p.nonce, 1);
        eq(p.nextActionAt, game.startAt() + 2);
        _at(2);
        _build(ALICE, 24, Core.Kind.Objective);
        _cell(24, Core.Kind.Objective, 1, 100, true);
        eq(game.energyOf(ALICE), 75);
    }

    function test_InvalidBuildsAreAtomic() public {
        _reject(ALICE, Core.ActionType.Build, 49, Core.Kind.Relay, Core.InvalidTile.selector);
        _reject(ALICE, Core.ActionType.Build, 255, Core.Kind.Relay, Core.InvalidTile.selector);
        _reject(ALICE, Core.ActionType.Build, 22, Core.Kind.Relay, Core.InvalidTarget.selector);
        _reject(ALICE, Core.ActionType.Build, 0, Core.Kind.Relay, Core.NotConnected.selector);
        _reject(ALICE, Core.ActionType.Build, 23, Core.Kind.Reactor, Core.InvalidKind.selector);
        _reject(ALICE, Core.ActionType.Build, 23, Core.Kind.Objective, Core.InvalidKind.selector);
        _reject(ALICE, Core.ActionType.Build, 24, Core.Kind.Turret, Core.InvalidKind.selector);
        _reject(OTHER, Core.ActionType.Build, 23, Core.Kind.Relay, Core.NotPlayer.selector);
    }

    function test_CooldownAndOldNonceCannotReplay() public {
        _build(ALICE, 23, Core.Kind.Relay);
        vm.expectRevert(Core.WrongNonce.selector);
        vm.prank(ALICE);
        game.act(Core.ActionType.Build, 24, Core.Kind.Objective, 0);
        _at(1);
        _reject(ALICE, Core.ActionType.Build, 24, Core.Kind.Objective, Core.CoolingDown.selector);
        _at(2);
        _build(ALICE, 24, Core.Kind.Objective);
    }

    function test_EnergyCapDoesNotBankOverflow() public {
        _at(20);
        eq(game.energyOf(ALICE), 120);
        _build(ALICE, 23, Core.Kind.Turret);
        eq(game.energyOf(ALICE), 85);
        _at(21);
        eq(game.energyOf(ALICE), 90);
        _at(22);
        _build(ALICE, 17, Core.Kind.Turret);
        eq(game.energyOf(ALICE), 60);
        _at(24);
        _build(ALICE, 16, Core.Kind.Turret);
        eq(game.energyOf(ALICE), 35);
        _at(26);
        _build(ALICE, 15, Core.Kind.Turret);
        eq(game.energyOf(ALICE), 10);
        _at(28);
        _reject(ALICE, Core.ActionType.Build, 14, Core.Kind.Turret, Core.InsufficientEnergy.selector);
        eq(game.energyOf(ALICE), 20);
        _at(31);
        _build(ALICE, 14, Core.Kind.Turret);
        eq(game.energyOf(ALICE), 0);
        _at(1000);
        eq(game.energyOf(ALICE), 120);
    }

    function _frontline() internal {
        _at(0);
        _build(ALICE, 23, Core.Kind.Relay);
        _build(BOB, 25, Core.Kind.Relay);
        _at(2);
        _build(ALICE, 24, Core.Kind.Objective);
    }

    function test_AttackDestroyDoesNotCaptureObjective() public {
        _frontline();
        _at(4);
        _attack(BOB, 24);
        _cell(24, Core.Kind.Objective, 1, 65, true);
        _at(6);
        _attack(BOB, 24);
        _cell(24, Core.Kind.Objective, 1, 30, true);
        _at(8);
        _attack(BOB, 24);
        _cell(24, Core.Kind.Empty, 0, 0, false);
        _at(10);
        _build(BOB, 24, Core.Kind.Objective);
        _cell(24, Core.Kind.Objective, 2, 100, true);
    }

    function test_RepairClampsAndRecordsEffectiveHp() public {
        _frontline();
        _at(4);
        _attack(BOB, 24);
        _at(6);
        _repair(ALICE, 24);
        _cell(24, Core.Kind.Objective, 1, 95, true);
        _at(8);
        uint16 beforeEnergy = game.energyOf(ALICE);
        vm.recordLogs();
        _repair(ALICE, 24);
        _cell(24, Core.Kind.Objective, 1, 100, true);
        eq(game.energyOf(ALICE), beforeEnergy - 12);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (,,, uint16 effective,,,,) =
            abi.decode(logs[0].data, (Core.ActionType, uint8, uint32, uint16, uint16, uint64, uint64, uint64));
        eq(effective, 5);
        _at(10);
        _reject(ALICE, Core.ActionType.Repair, 24, Core.Kind.Empty, Core.InvalidTarget.selector);
    }

    function test_ReactorFriendlyFireAndEmptyRepairRejected() public {
        _reject(ALICE, Core.ActionType.Attack, 21, Core.Kind.Empty, Core.InvalidTarget.selector);
        _reject(ALICE, Core.ActionType.Attack, 27, Core.Kind.Empty, Core.InvalidTarget.selector);
        _reject(ALICE, Core.ActionType.Attack, 22, Core.Kind.Empty, Core.InvalidTarget.selector);
        _reject(ALICE, Core.ActionType.Repair, 23, Core.Kind.Empty, Core.InvalidTarget.selector);
        _reject(ALICE, Core.ActionType.Repair, 26, Core.Kind.Empty, Core.InvalidTarget.selector);
        _reject(ALICE, Core.ActionType.Attack, 26, Core.Kind.Relay, Core.InvalidKind.selector);
    }

    function _cutSupply(bool alternate) internal {
        _frontline();
        _at(4);
        _build(BOB, 18, Core.Kind.Relay);
        _at(6);
        _build(BOB, 17, Core.Kind.Relay);
        if (alternate) {
            _at(8);
            _build(ALICE, 29, Core.Kind.Relay);
            _at(10);
            _build(ALICE, 30, Core.Kind.Relay);
        }
        _at(12);
        _attack(BOB, 23);
        _at(14);
        _attack(BOB, 23);
        _at(16);
        _attack(BOB, 23);
    }

    function test_CutAndReconnectThroughAlternativePath() public {
        _cutSupply(false);
        _cell(23, Core.Kind.Empty, 0, 0, false);
        _cell(24, Core.Kind.Objective, 1, 100, false);
        (uint16 a,) = game.scores();
        eq(a, 14);
        _at(20);
        _reject(ALICE, Core.ActionType.Build, 31, Core.Kind.Relay, Core.NotConnected.selector);
        _build(ALICE, 29, Core.Kind.Relay);
        _at(22);
        _build(ALICE, 30, Core.Kind.Relay);
        _cell(24, Core.Kind.Objective, 1, 100, true);
        _at(30);
        (a,) = game.scores();
        eq(a, 22);
    }

    function test_ExistingAlternatePathSurvivesCut() public {
        _cutSupply(true);
        _cell(24, Core.Kind.Objective, 1, 100, true);
        _at(30);
        (uint16 a,) = game.scores();
        eq(a, 28);
    }

    function test_RepairDestroyedTileRequiresRebuild() public {
        _cutSupply(false);
        _at(20);
        _reject(ALICE, Core.ActionType.Repair, 23, Core.Kind.Empty, Core.InvalidTarget.selector);
        _build(ALICE, 23, Core.Kind.Relay);
        _cell(24, Core.Kind.Objective, 1, 100, true);
    }

    function test_OfflineDamagedBuildingCannotBeRepairedFromIsolation() public {
        _frontline();
        _at(4);
        _attack(BOB, 24);
        _at(6);
        _build(BOB, 18, Core.Kind.Relay);
        _at(8);
        _build(BOB, 17, Core.Kind.Relay);
        _at(10);
        _attack(BOB, 23);
        _at(12);
        _attack(BOB, 23);
        _at(14);
        _attack(BOB, 23);
        _at(16);
        _reject(ALICE, Core.ActionType.Repair, 24, Core.Kind.Empty, Core.NotConnected.selector);
    }

    function _combat(bool turret, bool shield, bool stack) internal {
        _at(0);
        _build(ALICE, 23, Core.Kind.Relay);
        _build(BOB, 25, shield ? Core.Kind.Shield : Core.Kind.Relay);
        _at(2);
        _build(ALICE, 24, Core.Kind.Objective);
        if (turret) {
            _at(4);
            _build(ALICE, 18, Core.Kind.Turret);
        }
        if (stack) {
            _at(6);
            _build(ALICE, 31, Core.Kind.Turret);
            _build(BOB, 19, Core.Kind.Shield);
        }
        _at(10);
        _attack(ALICE, 25);
        uint16 expected = (shield ? 120 : 100) - (35 + (turret ? 10 : 0) - (shield ? 10 : 0));
        _cell(25, shield ? Core.Kind.Shield : Core.Kind.Relay, 2, expected, true);
    }

    function test_BaseDamage() public {
        _combat(false, false, false);
    }

    function test_TurretDamage() public {
        _combat(true, false, false);
    }

    function test_ShieldDamage() public {
        _combat(false, true, false);
    }

    function test_TurretAndShieldDamage() public {
        _combat(true, true, false);
    }

    function test_BonusesDoNotStack() public {
        _combat(true, true, true);
    }

    function test_DisconnectedTurretLosesAttackBonus() public {
        _frontline();
        _at(4);
        _build(ALICE, 17, Core.Kind.Relay);
        _at(6);
        _build(ALICE, 11, Core.Kind.Turret);
        _build(BOB, 18, Core.Kind.Relay);
        _at(8);
        _attack(BOB, 17);
        _at(10);
        _attack(BOB, 17);
        _at(12);
        _attack(BOB, 17);
        _cell(11, Core.Kind.Turret, 1, 120, false);
        _at(14);
        _attack(ALICE, 18);
        _cell(18, Core.Kind.Relay, 2, 65, true);
    }

    function test_DisconnectedShieldLosesDefense() public {
        _frontline();
        _at(4);
        _build(BOB, 19, Core.Kind.Shield);
        _build(ALICE, 17, Core.Kind.Relay);
        _at(6);
        _build(ALICE, 11, Core.Kind.Relay);
        _at(8);
        _build(ALICE, 12, Core.Kind.Relay);
        _at(10);
        _build(ALICE, 13, Core.Kind.Relay);
        _at(12);
        _build(ALICE, 20, Core.Kind.Relay);
        _at(14);
        _attack(ALICE, 26);
        _at(16);
        _attack(ALICE, 26);
        _at(18);
        _attack(ALICE, 26);
        _at(20);
        _attack(ALICE, 26);
        _cell(26, Core.Kind.Empty, 0, 0, false);
        _cell(19, Core.Kind.Shield, 2, 120, false);
        _at(22);
        _attack(ALICE, 25);
        _cell(25, Core.Kind.Relay, 2, 65, false);
    }

    function test_AllObjectivesAccumulateWithoutHeartbeatAndRespectCap() public {
        _at(0);
        _build(ALICE, 23, Core.Kind.Relay);
        _at(2);
        _build(ALICE, 24, Core.Kind.Objective);
        _at(4);
        _build(ALICE, 17, Core.Kind.Relay);
        _at(6);
        _build(ALICE, 10, Core.Kind.Objective);
        _at(8);
        _build(ALICE, 31, Core.Kind.Relay);
        _at(10);
        _build(ALICE, 38, Core.Kind.Objective);
        _at(10000);
        (uint16 purple, uint16 amber, uint8 winner) = game.finalize();
        eq(purple, 3 * game.DURATION() - 18);
        eq(amber, 0);
        eq(winner, 1);
        require(purple + amber <= 3 * game.DURATION(), "one-zone score cap");
    }

    function test_HighSMalleabilityIsRejected() public {
        (Core.Action memory a,) = _signedAction();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, game.actionDigest(a));
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory highS = abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(Core.InvalidSignature.selector);
        game.actSigned(a, highS);
    }

    function test_SessionCannotBeReplayedAfterLeaveAndRejoin() public {
        Core g = new NadWarsSingleZone(bytes32("session-rejoin"));
        vm.prank(ALICE);
        g.join(1);
        address key = vm.addr(SESSION_KEY);
        vm.prank(ALICE);
        g.authorizeSession(key, uint64(block.timestamp + 500), 7);
        (,, uint32 oldVersion,) = g.sessions(ALICE);
        Core.Action memory a = Core.Action(
            ALICE, 0, uint64(block.timestamp + 400), oldVersion, Core.ActionType.Build, 23, Core.Kind.Relay
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, g.actionDigest(a));
        vm.prank(ALICE);
        g.leave();
        vm.prank(ALICE);
        g.join(2);
        vm.prank(ALICE);
        g.authorizeSession(key, uint64(block.timestamp + 500), 7);
        vm.expectRevert(Core.InvalidSession.selector);
        g.actSigned(a, abi.encodePacked(r, s, v));
    }

    function test_ScoreSettlesOldRatesAndClampsEnd() public {
        _at(0);
        _build(ALICE, 23, Core.Kind.Relay);
        _build(BOB, 25, Core.Kind.Relay);
        _at(10);
        _build(ALICE, 24, Core.Kind.Objective);
        _at(12);
        _build(ALICE, 17, Core.Kind.Relay);
        _at(25);
        _build(ALICE, 10, Core.Kind.Objective);
        _at(36);
        _attack(BOB, 24);
        _at(38);
        _attack(BOB, 24);
        _at(40);
        _attack(BOB, 24);
        (uint16 a, uint16 b) = game.scores();
        eq(a, 45);
        eq(b, 0);
        _at(1000);
        (a, b) = game.scores();
        eq(a, game.DURATION() + 5);
        eq(b, 0);
        uint8 winner;
        (a, b, winner) = game.finalize();
        eq(a, game.DURATION() + 5);
        eq(b, 0);
        eq(winner, 1);
        _at(2000);
        (uint16 x, uint16 y, uint8 w) = game.finalize();
        eq(x, a);
        eq(y, b);
        eq(w, winner);
    }

    function test_SameSecondActionsDoNotDoubleScore() public {
        _frontline();
        _at(12);
        _build(ALICE, 17, Core.Kind.Relay);
        _attack(BOB, 24);
        (uint16 a,) = game.scores();
        eq(a, 10);
    }

    function test_EndBoundaryAndTieAndPermissionlessFinalize() public {
        _at(game.DURATION()-1);
        _build(ALICE, 23, Core.Kind.Relay);
        _at(game.DURATION());
        _reject(ALICE, Core.ActionType.Build, 24, Core.Kind.Objective, Core.WrongPhase.selector);
        vm.prank(OTHER);
        (uint16 a, uint16 b, uint8 winner) = game.finalize();
        eq(a, 0);
        eq(b, 0);
        eq(winner, 0);
        eq(uint8(game.phase()), uint8(Core.Phase.Finished));
    }

    function test_FrontRunningOccupancyCannotOverwrite() public {
        _at(0);
        _build(ALICE, 23, Core.Kind.Relay);
        _build(BOB, 25, Core.Kind.Relay);
        _at(2);
        _build(BOB, 24, Core.Kind.Objective);
        _reject(ALICE, Core.ActionType.Build, 24, Core.Kind.Objective, Core.InvalidTarget.selector);
        _cell(24, Core.Kind.Objective, 2, 100, true);
    }

    function test_LobbyAndCountdownBoundaries() public {
        Core g = new NadWarsSingleZone(bytes32("lobby"));
        vm.expectRevert(Core.NotReady.selector);
        g.start();
        vm.prank(ALICE);
        g.join(1);
        uint32 r = g.rosterVersion();
        bytes32 rules = g.RULES_HASH();
        vm.prank(ALICE);
        g.setReady(r, rules);
        vm.prank(BOB);
        g.join(2);
        no(g.playerState(ALICE).ready);
        vm.expectRevert(Core.StaleRoster.selector);
        vm.prank(ALICE);
        g.setReady(r, rules);
        r = g.rosterVersion();
        vm.expectRevert(Core.InvalidRules.selector);
        vm.prank(ALICE);
        g.setReady(r, bytes32(0));
        vm.prank(ALICE);
        g.setReady(r, rules);
        vm.prank(BOB);
        g.setReady(r, rules);
        g.start();
        vm.expectRevert(Core.WrongPhase.selector);
        vm.prank(ALICE);
        g.act(Core.ActionType.Build, 23, Core.Kind.Relay, 0);
        vm.expectRevert(Core.WrongPhase.selector);
        g.cancel();
        vm.expectRevert(Core.WrongPhase.selector);
        vm.prank(ALICE);
        g.leave();
        vm.warp(g.startAt());
        vm.prank(ALICE);
        g.act(Core.ActionType.Build, 23, Core.Kind.Relay, 0);
    }

    function test_LobbyExpiryAndCancellation() public {
        Core g = new NadWarsSingleZone(bytes32("expiry"));
        vm.expectRevert(Core.Unauthorized.selector);
        vm.prank(OTHER);
        g.cancel();
        vm.warp(g.createdAt() + 600);
        vm.expectRevert(Core.WrongPhase.selector);
        vm.prank(ALICE);
        g.join(1);
        vm.prank(OTHER);
        g.cancel();
        eq(uint8(g.phase()), uint8(Core.Phase.Cancelled));
        vm.expectRevert(Core.WrongPhase.selector);
        g.finalize();
    }

    function test_DuplicateSeatAndLeaveInvalidateReadiness() public {
        Core g = new NadWarsSingleZone(bytes32("roster"));
        vm.prank(ALICE);
        g.join(1);
        vm.expectRevert(Core.AlreadyJoined.selector);
        vm.prank(ALICE);
        g.join(2);
        vm.expectRevert(Core.SeatOccupied.selector);
        vm.prank(BOB);
        g.join(1);
        vm.expectRevert(Core.InvalidTeam.selector);
        vm.prank(BOB);
        g.join(0);
        vm.prank(BOB);
        g.join(2);
        uint32 r = g.rosterVersion();
        bytes32 rules = g.RULES_HASH();
        vm.prank(ALICE);
        g.setReady(r, rules);
        vm.prank(BOB);
        g.setReady(r, rules);
        vm.prank(BOB);
        g.leave();
        no(g.playerState(ALICE).ready);
        vm.expectRevert(Core.NotReady.selector);
        g.start();
    }

    function _signedAction() internal returns (Core.Action memory a, bytes memory sig) {
        address key = vm.addr(SESSION_KEY);
        vm.prank(ALICE);
        game.authorizeSession(key, uint64(block.timestamp + 300), 7);
        (,, uint32 ver,) = game.sessions(ALICE);
        a = Core.Action(ALICE, 0, uint64(block.timestamp + 100), ver, Core.ActionType.Build, 23, Core.Kind.Relay);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, game.actionDigest(a));
        sig = abi.encodePacked(r, s, v);
    }

    function test_SignedActionAndReplayProtection() public {
        (Core.Action memory a, bytes memory sig) = _signedAction();
        vm.prank(OTHER);
        game.actSigned(a, sig);
        _cell(23, Core.Kind.Relay, 1, 100, true);
        _at(2);
        vm.expectRevert(Core.WrongNonce.selector);
        game.actSigned(a, sig);
    }

    function test_SignatureBindsAllActionFields() public {
        (Core.Action memory a, bytes memory sig) = _signedAction();
        a.tile = 17;
        vm.expectRevert(Core.InvalidSignature.selector);
        game.actSigned(a, sig);
        a.tile = 23;
        a.kind = Core.Kind.Shield;
        vm.expectRevert(Core.InvalidSignature.selector);
        game.actSigned(a, sig);
    }

    function test_SignatureCannotCrossChainOrContract() public {
        (Core.Action memory a, bytes memory sig) = _signedAction();
        uint256 chain = block.chainid;
        vm.chainId(chain + 1);
        vm.expectRevert(Core.InvalidSignature.selector);
        game.actSigned(a, sig);
        vm.chainId(chain);
        Core other = new NadWarsSingleZone(bytes32("other-match"));
        _start(other);
        address key = vm.addr(SESSION_KEY);
        vm.prank(ALICE);
        other.authorizeSession(key, uint64(block.timestamp + 300), 7);
        vm.expectRevert(Core.InvalidSignature.selector);
        other.actSigned(a, sig);
    }

    function test_RevocationAndRotationDoNotResetPlayer() public {
        (Core.Action memory a, bytes memory sig) = _signedAction();
        game.actSigned(a, sig);
        Core.Player memory beforePlayer = game.playerState(ALICE);
        vm.prank(ALICE);
        game.revokeSession();
        vm.expectRevert(Core.InvalidSession.selector);
        game.actSigned(a, sig);
        address key = vm.addr(SESSION_KEY);
        vm.prank(ALICE);
        game.authorizeSession(key, uint64(block.timestamp + 300), 7);
        eq(keccak256(abi.encode(beforePlayer)), keccak256(abi.encode(game.playerState(ALICE))));
        vm.expectRevert(Core.InvalidSession.selector);
        game.actSigned(a, sig);
    }

    function test_SessionExpiryDeadlineAndActionMask() public {
        (Core.Action memory a, bytes memory sig) = _signedAction();
        _at(101);
        vm.expectRevert(Core.ExpiredAction.selector);
        game.actSigned(a, sig);
        _at(0);
        address key = vm.addr(SESSION_KEY);
        vm.prank(ALICE);
        game.authorizeSession(key, uint64(block.timestamp + 10), 2);
        (,, a.sessionVersion,) = game.sessions(ALICE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, game.actionDigest(a));
        sig = abi.encodePacked(r, s, v);
        vm.expectRevert(Core.InvalidSession.selector);
        game.actSigned(a, sig);
        _at(10);
        vm.expectRevert(Core.InvalidSession.selector);
        game.actSigned(a, sig);
    }

    function test_SessionCannotActAfterGameEnds() public {
        (Core.Action memory a,) = _signedAction();
        a.deadline = game.endAt() + 20;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, game.actionDigest(a));
        _at(game.DURATION());
        vm.expectRevert(Core.WrongPhase.selector);
        game.actSigned(a, abi.encodePacked(r, s, v));
    }

    function test_InvalidSignaturesAndUnauthorizedSessionManagement() public {
        (Core.Action memory a, bytes memory sig) = _signedAction();
        vm.expectRevert(Core.InvalidSignature.selector);
        game.actSigned(a, hex"01");
        sig[64] = bytes1(uint8(0));
        vm.expectRevert(Core.InvalidSignature.selector);
        game.actSigned(a, sig);
        vm.expectRevert(Core.NotPlayer.selector);
        vm.prank(OTHER);
        game.revokeSession();
        uint64 end = game.endAt();
        vm.expectRevert(Core.InvalidSession.selector);
        vm.prank(ALICE);
        game.authorizeSession(address(0), end, 7);
    }

    function test_ReplayEventsReconstructFinalBoard() public {
        uint32[49] memory replay = game.board();
        vm.recordLogs();
        _cutSupply(false);
        _at(20);
        _build(ALICE, 29, Core.Kind.Relay);
        _at(22);
        _build(ALICE, 30, Core.Kind.Relay);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 eventSig =
            keccak256("ActionResolved(address,uint64,uint8,uint8,uint32,uint16,uint16,uint64,uint64,uint64)");
        uint256 actions;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(game) || logs[i].topics[0] != eventSig) continue;
            (, uint8 tile, uint32 afterCell,,,,,) =
                abi.decode(logs[i].data, (Core.ActionType, uint8, uint32, uint16, uint16, uint64, uint64, uint64));
            replay[tile] = afterCell;
            ++actions;
        }
        eq(actions, 10);
        eq(keccak256(abi.encode(replay)), game.boardHash());
        _at(500);
        game.finalize();
        eq(keccak256(abi.encode(replay)), game.boardHash());
    }

    function test_LayoutsHaveSameRulesAndDifferentPages() public {
        Core baseline = new NadWarsScatteredZone(bytes32("baseline"));
        eq(game.RULES_HASH(), baseline.RULES_HASH());
        eq(game.boardHash(), baseline.boardHash());
        uint256 page = uint256(game.storageSlot(0)) >> 7;
        for (uint8 i; i < 49; ++i) {
            eq(uint256(game.storageSlot(i)) >> 7, page);
            for (uint8 j; j < i; ++j) {
                require(
                    uint256(baseline.storageSlot(i)) >> 7 != uint256(baseline.storageSlot(j)) >> 7,
                    "baseline page collision"
                );
            }
        }
    }

    function testFuzz_DifferentialTransitionsAndBounds(uint256 seed) public {
        vm.warp(game.createdAt());
        Core other = new NadWarsScatteredZone(bytes32("differential"));
        _start(other);
        // Align game timestamps before state comparison. No transactions happened in the first game.
        uint256 origin = block.timestamp;
        for (uint256 i; i < 64; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(origin + i * 3);
            address who = (seed & 1) == 0 ? ALICE : BOB;
            Core.ActionType action = Core.ActionType((seed >> 8) % 3);
            uint8 tile = uint8((seed >> 16) % 55);
            Core.Kind kind = action == Core.ActionType.Build ? Core.Kind(2 + (seed >> 24) % 4) : Core.Kind.Empty;
            uint64 nonce = game.playerState(who).nonce;
            bytes memory input = abi.encodeCall(Core.act, (action, tile, kind, nonce));
            vm.prank(who);
            (bool a, bytes memory x) = address(game).call(input);
            vm.prank(who);
            (bool b, bytes memory y) = address(other).call(input);
            require(a == b, "layout acceptance mismatch");
            eq(keccak256(x), keccak256(y));
            eq(game.boardHash(), other.boardHash());
            eq(game.power1(), other.power1());
            eq(game.power2(), other.power2());
            require((game.power1() & game.power2()) == 0, "overlapping team power");
            require(game.energyOf(ALICE) <= 120 && game.energyOf(BOB) <= 120, "energy bound");
            (uint16 s1, uint16 s2) = game.scores();
            require(s1 + s2 <= 3 * game.DURATION(), "score bound");
            eq(game.playerState(ALICE).nonce, other.playerState(ALICE).nonce);
            eq(game.playerState(BOB).nonce, other.playerState(BOB).nonce);
        }
    }
}
