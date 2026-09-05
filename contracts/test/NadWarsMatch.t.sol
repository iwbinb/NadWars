// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TestBase} from "./TestBase.sol";
import {NadWarsMatch as Game} from "../src/NadWarsMatch.sol";
import {NadWarsScatteredMatch} from "../src/benchmarks/NadWarsScatteredMatch.sol";

contract NadWarsMatchTest is TestBase {
    Game internal game;
    address[8] internal users;
    function setUp() public {
        vm.warp(1000);
        for (uint8 i; i < 8; ++i) users[i] = address(uint160(0x100 + i));
        game = new Game(bytes32("standard"));
        _start(game);
        vm.warp(game.startAt());
    }
    function _start(Game g) internal {
        for (uint8 i; i < 8; ++i) { vm.prank(users[i]); g.join(i < 4 ? 1 : 2); }
        uint32 roster = g.rosterVersion(); bytes32 rules = g.RULES_HASH();
        for (uint8 i; i < 8; ++i) { vm.prank(users[i]); g.setReady(roster,rules); }
        g.start();
    }
    function _at(uint256 t) internal { vm.warp(uint256(game.startAt()) + t); }
    function _act(uint8 user, Game.ActionType action, uint8 zone, uint8 tile, Game.Kind kind) internal {
        uint64 nonce = game.playerState(users[user]).nonce;
        vm.prank(users[user]); game.act(action,zone,tile,kind,nonce);
    }
    function _build(uint8 u, uint8 z, uint8 t, Game.Kind k) internal { _act(u,Game.ActionType.Build,z,t,k); }
    function _support(uint8 u, uint8 z) internal { _act(u,Game.ActionType.Support,z,0,Game.Kind.Empty); }
    function _state(Game g) internal view returns (bytes32 result) {
        result = keccak256(abi.encode(g.boardHash(),g.phase()));
        for (uint8 i; i < 4; ++i) {
            (uint32[49] memory b,uint64 p1,uint64 p2,uint16 s1,uint16 s2,uint64 t) = g.zoneState(i);
            result = keccak256(abi.encode(result,b,p1,p2,s1,s2,t));
        }
        for (uint8 i; i < 8; ++i) result = keccak256(abi.encode(result,g.playerState(users[i]),g.energyOf(users[i])));
    }
    function _reject(uint8 u, Game.ActionType a, uint8 z, uint8 t, Game.Kind k, bytes4 err) internal {
        bytes32 beforeState = _state(game); uint64 n = game.playerState(users[u]).nonce;
        vm.recordLogs(); vm.expectRevert(err); vm.prank(users[u]); game.act(a,z,t,k,n);
        eq(beforeState,_state(game)); eq(vm.getRecordedLogs().length,0);
    }
    function test_EightSeatsAndIndependentPages() public view {
        eq(game.PLAYER_COUNT(),8); eq(game.ZONE_COUNT(),4);
        for (uint8 i; i < 8; ++i) {
            eq(uint160(game.seats(i)),uint160(users[i]));
            eq(game.playerState(users[i]).zone,i % 4); eq(game.energyOf(users[i]),100);
        }
        for (uint8 z; z < 4; ++z) {
            eq(keccak256(abi.encode(game.board(z))),keccak256(abi.encode(game.board(0))));
            uint256 first = uint256(game.storageSlot(z,0));
            eq(first % 128,0); eq(uint256(game.storageSlot(z,48)) / 128, first / 128);
            if (z > 0) eq(first - uint256(game.storageSlot(z-1,0)),128);
        }
    }
    function test_AllEightMustReadyAndRosterChangesInvalidateEveryone() public {
        Game g = new Game(bytes32("waiting")); bytes32 rules = g.RULES_HASH();
        for (uint8 i; i < 7; ++i) { vm.prank(users[i]); g.join(i < 4 ? 1 : 2); }
        uint32 roster = g.rosterVersion();
        for (uint8 i; i < 7; ++i) { vm.prank(users[i]); g.setReady(roster,rules); }
        vm.expectRevert(Game.NotReady.selector); g.start();
        vm.prank(users[7]); g.join(2);
        for (uint8 i; i < 8; ++i) no(g.playerState(users[i]).ready);
        vm.expectRevert(Game.StaleRoster.selector); vm.prank(users[0]); g.setReady(roster,rules);
        vm.prank(users[1]); g.leave(); vm.prank(address(0x999)); g.join(1);
        eq(g.playerState(address(0x999)).zone,1);
        vm.expectRevert(Game.SeatOccupied.selector); vm.prank(address(0x998)); g.join(1);
    }
    function test_ZoneWriteDoesNotChangeOtherZonesOrPlayers() public {
        bytes32 before1 = keccak256(abi.encode(game.board(1)));
        bytes32 before2 = keccak256(abi.encode(game.board(2)));
        bytes32 other = keccak256(abi.encode(game.playerState(users[1])));
        _build(0,0,23,Game.Kind.Relay);
        eq(before1,keccak256(abi.encode(game.board(1)))); eq(before2,keccak256(abi.encode(game.board(2))));
        eq(other,keccak256(abi.encode(game.playerState(users[1]))));
        _reject(0,Game.ActionType.Build,1,23,Game.Kind.Relay,Game.CoolingDown.selector);
        _at(2); _reject(0,Game.ActionType.Build,1,23,Game.Kind.Relay,Game.WrongZone.selector);
    }
    function test_DifferentZoneActionsCommute() public {
        uint256 snap = vm.snapshotState();
        _build(0,0,23,Game.Kind.Relay); _build(1,1,23,Game.Kind.Relay);
        bytes32 expected = _state(game); yes(vm.revertToState(snap));
        _build(1,1,23,Game.Kind.Relay); _build(0,0,23,Game.Kind.Relay); eq(expected,_state(game));
    }
    function test_SupportArrivalIsLazyAndDoesNotResetEnergy() public {
        _support(0,1); eq(game.energyOf(users[0]),75);
        _at(2); _reject(0,Game.ActionType.Build,0,23,Game.Kind.Relay,Game.InTransit.selector);
        _reject(0,Game.ActionType.Support,2,0,Game.Kind.Empty,Game.InTransit.selector);
        _at(4); (uint8 z,uint64 arrives) = game.currentZoneOf(users[0]); eq(z,0); eq(arrives,game.startAt()+5);
        _at(5); (z,arrives) = game.currentZoneOf(users[0]); eq(z,1); eq(arrives,0); eq(game.energyOf(users[0]),100);
        _reject(0,Game.ActionType.Build,0,23,Game.Kind.Relay,Game.WrongZone.selector);
        _build(0,1,23,Game.Kind.Relay); eq(game.playerState(users[0]).zone,1); eq(game.energyOf(users[0]),85);
        eq(game.playerState(users[0]).nonce,2);
    }
    function test_SupportCannotJumpDiagonalOrCarryPayload() public {
        _reject(0,Game.ActionType.Support,3,0,Game.Kind.Empty,Game.InvalidRoute.selector);
        _reject(0,Game.ActionType.Support,0,0,Game.Kind.Empty,Game.InvalidRoute.selector);
        _reject(0,Game.ActionType.Support,1,1,Game.Kind.Empty,Game.InvalidTarget.selector);
        _reject(0,Game.ActionType.Support,4,0,Game.Kind.Empty,Game.InvalidZone.selector);
    }
    function test_TeammatesCanConvergeButCannotDoubleBuild() public {
        _support(0,1); _at(5); _build(0,1,23,Game.Kind.Relay);
        _reject(1,Game.ActionType.Build,1,23,Game.Kind.Relay,Game.InvalidTarget.selector);
        _build(1,1,24,Game.Kind.Objective);
        eq(game.energyOf(users[1]),100); // 120 regenerated minus objective cost.
        (,,uint16 hp,bool power) = game.cell(1,24); eq(hp,100); yes(power);
    }
    function test_FourZonesScoreIndependentlyAndLateFinalizationIsIdempotent() public {
        for (uint8 z; z < 4; ++z) _build(z,z,23,Game.Kind.Relay);
        _at(2); for (uint8 z; z < 4; ++z) _build(z,z,24,Game.Kind.Objective);
        _at(50); for (uint8 z; z < 4; ++z) { (uint16 a,uint16 b) = game.zoneScores(z); eq(a,48); eq(b,0); }
        _at(1000); (uint16 a,uint16 b,uint8 winner) = game.finalize(); eq(a,4 * (game.DURATION() - 2)); eq(b,0); eq(winner,1);
        bytes32 beforeState = _state(game); game.finalize(); eq(beforeState,_state(game));
        _reject(0,Game.ActionType.Support,1,0,Game.Kind.Empty,Game.WrongPhase.selector);
    }
    function test_CutRepairAndAlternateRouteRemainLocal() public {
        _build(0,0,23,Game.Kind.Relay); _build(4,0,25,Game.Kind.Relay);
        _at(2); _build(0,0,24,Game.Kind.Objective); _act(4,Game.ActionType.Attack,0,24,Game.Kind.Empty);
        _at(4); _act(0,Game.ActionType.Repair,0,24,Game.Kind.Empty); _build(4,0,18,Game.Kind.Relay);
        _at(6); _build(4,0,17,Game.Kind.Relay);
        for (uint8 i; i < 3; ++i) { _at(8+i*2); _act(4,Game.ActionType.Attack,0,23,Game.Kind.Empty); }
        (,,,bool powered) = game.cell(0,24); no(powered);
        (uint16 beforeScore,) = game.zoneScores(0); _at(20); (uint16 afterScore,) = game.zoneScores(0); eq(beforeScore,afterScore);
        _build(0,0,29,Game.Kind.Relay); _at(22); _build(0,0,30,Game.Kind.Relay);
        (,,,powered) = game.cell(0,24); yes(powered);
        (uint16 untouched,) = game.zoneScores(1); eq(untouched,0);
    }
    function test_CountdownAndEndBoundaries() public {
        vm.warp(game.startAt()-1); _reject(0,Game.ActionType.Build,0,23,Game.Kind.Relay,Game.WrongPhase.selector);
        _at(game.DURATION()-1); _support(0,1); _at(game.DURATION()+4);
        (uint8 zone,) = game.currentZoneOf(users[0]); eq(zone,1);
        _reject(0,Game.ActionType.Build,1,23,Game.Kind.Relay,Game.WrongPhase.selector);
        (uint16 a,uint16 b,uint8 w) = game.finalize(); eq(a,0); eq(b,0); eq(w,0);
    }
    function _signature(Game g, Game.Action memory a, uint256 key) internal returns (bytes memory) {
        (uint8 v,bytes32 r,bytes32 s) = vm.sign(key,g.actionDigest(a)); return abi.encodePacked(r,s,v);
    }
    function test_SignedSupportBindsZoneNonceSessionAndChain() public {
        vm.chainId(31337); uint256 key = 0xAABB; address session = vm.addr(key);
        uint64 expiry=game.endAt(); vm.prank(users[0]); game.authorizeSession(session,expiry,15);
        Game.Action memory a = Game.Action(users[0],0,game.endAt(),1,Game.ActionType.Support,1,0,Game.Kind.Empty);
        bytes memory sig = _signature(game,a,key);
        a.zone = 2; vm.expectRevert(Game.InvalidSignature.selector); game.actSigned(a,sig); a.zone = 1;
        vm.chainId(31338); vm.expectRevert(Game.InvalidSignature.selector); game.actSigned(a,sig); vm.chainId(31337);
        game.actSigned(a,sig); vm.expectRevert(Game.WrongNonce.selector); game.actSigned(a,sig);
        vm.prank(users[0]); game.revokeSession(); _at(5); a.nonce = 1;
        vm.expectRevert(Game.InvalidSession.selector); game.actSigned(a,sig);
    }
    function test_SessionActionMaskRejectsSupportAndExpiryIsExclusive() public {
        uint256 key=0xAABC; address session=vm.addr(key);
        uint64 expiry=game.startAt()+10; vm.prank(users[0]); game.authorizeSession(session,expiry,7);
        Game.Action memory a = Game.Action(users[0],0,game.endAt(),1,Game.ActionType.Support,1,0,Game.Kind.Empty);
        bytes memory sig=_signature(game,a,key); vm.expectRevert(Game.InvalidSession.selector); game.actSigned(a,sig);
        a.action=Game.ActionType.Build; a.zone=0; a.tile=23; a.kind=Game.Kind.Relay; sig=_signature(game,a,key);
        _at(10); vm.expectRevert(Game.InvalidSession.selector); game.actSigned(a,sig);
    }
    function testFuzz_LayoutsHaveIdenticalStateAndFailureAtomicity(uint256 seed) public {
        vm.warp(game.createdAt());
        Game other = new NadWarsScatteredMatch(bytes32("comparison")); _start(other);
        // Both matches start at the same timestamp for the differential trace.
        vm.warp(other.startAt());
        for (uint8 step; step < 16; ++step) {
            seed=uint256(keccak256(abi.encode(seed,step)));
            vm.warp(uint256(game.startAt())+uint256(step+1)*2);
            uint8 u=uint8(seed%8); uint8 z=uint8((seed>>8)%5); uint8 tile=uint8((seed>>16)%51);
            Game.ActionType a=Game.ActionType(uint8((seed>>24)%4));
            Game.Kind k=a==Game.ActionType.Build ? Game.Kind(uint8(2+(seed>>32)%4)) : Game.Kind.Empty;
            if (a==Game.ActionType.Support) tile=0;
            uint64 n=game.playerState(users[u]).nonce;
            bytes32 beforeState=_state(game);
            vm.prank(users[u]); (bool ok,bytes memory result)=address(game).call(abi.encodeCall(Game.act,(a,z,tile,k,n)));
            vm.prank(users[u]); (bool ok2,bytes memory result2)=address(other).call(abi.encodeCall(Game.act,(a,z,tile,k,n)));
            require(ok==ok2,"acceptance differs"); eq(keccak256(result),keccak256(result2));
            if (!ok) eq(beforeState,_state(game));
            eq(_state(game),_state(other));
            for(uint8 zone;zone<4;++zone) eq(keccak256(abi.encode(game.board(zone))),keccak256(abi.encode(other.board(zone))));
            for(uint8 who;who<8;++who) { eq(game.playerState(users[who]).nonce,other.playerState(users[who]).nonce); yes(game.energyOf(users[who])<=120); }
            (uint16 s1,uint16 s2)=game.scores(); yes(s1+s2<=12 * game.DURATION());
        }
    }
}
