// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HexGrid} from "./HexGrid.sol";

/// @notice Two-player, one-zone PRACTICE game. Not an eight-player standard match.
/// @dev Both layouts inherit precisely the same transition and authorization code.
abstract contract NadWarsZoneCore {
    enum Phase {
        Waiting,
        Countdown,
        Active,
        AwaitingSettlement,
        Finished,
        Cancelled
    }
    enum Kind {
        Empty,
        Reactor,
        Relay,
        Objective,
        Turret,
        Shield
    }
    enum ActionType {
        Build,
        Attack,
        Repair
    }

    struct Player {
        uint64 energyAt;
        uint64 nextActionAt;
        uint64 nonce;
        uint16 energy;
        uint8 team;
        bool ready;
    }

    struct Session {
        address key;
        uint64 expiresAt;
        uint32 version;
        uint8 allowedActions;
    }

    struct Action {
        address player;
        uint64 nonce;
        uint64 deadline;
        uint32 sessionVersion;
        ActionType action;
        uint8 tile;
        Kind kind;
    }

    error WrongPhase();
    error InvalidTeam();
    error SeatOccupied();
    error AlreadyJoined();
    error NotPlayer();
    error NotReady();
    error StaleRoster();
    error InvalidRules();
    error Unauthorized();
    error InvalidTile();
    error InvalidKind();
    error InvalidTarget();
    error NotConnected();
    error CoolingDown();
    error InsufficientEnergy();
    error WrongNonce();
    error InvalidSession();
    error ExpiredAction();
    error InvalidSignature();
    error InvalidMatchId();

    uint64 public constant DURATION = 180;
    uint64 public constant COUNTDOWN = 5;
    uint64 public constant WAITING_TTL = 600;
    uint16 public constant INITIAL_ENERGY = 100;
    uint16 public constant MAX_ENERGY = 120;
    uint16 public constant ENERGY_PER_SECOND = 5;
    uint64 public constant COOLDOWN = 2;
    bytes32 public constant MODE = keccak256("NadWars:single-zone-practice:v0.1");
    bytes32 public constant MAP_HASH = keccak256(
        "axial7x7:q+r*7;neighbors:+1,0|-1,0|0,+1|0,-1|+1,-1|-1,+1;roots:21,27;relays:22,26;objectives:10,24,38"
    );
    bytes32 public constant RULES_HASH = keccak256(
        abi.encode(
            "NadWars-v0.1-single-zone-practice",
            MAP_HASH,
            uint256(2),
            uint256(1),
            uint256(60),
            uint256(5),
            uint256(600),
            uint256(100),
            uint256(120),
            uint256(5),
            uint256(2),
            "build:relay15/100,objective20/100,turret35/120,shield30/120;attack18/35;turret+10;shield-10;min10;repair12/30;score1perPoweredObjectiveSecond;tie0;supportUnavailable"
        )
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ACTION_TYPEHASH = keccak256(
        "GameAction(bytes32 matchId,bytes32 rulesHash,address player,uint64 nonce,uint64 deadline,uint32 sessionVersion,uint8 action,uint8 tile,uint8 kind)"
    );
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable creator;
    bytes32 public immutable matchId;
    uint64 public immutable createdAt;
    address[2] public seats;
    uint32 public rosterVersion;
    uint64 public startAt;
    uint64 public endAt;
    uint64 public scoreAt;
    uint64 public power1;
    uint64 public power2;
    uint16 internal storedScore1;
    uint16 internal storedScore2;
    bool public cancelled;
    bool public finished;
    mapping(address => Player) internal players;
    mapping(address => Session) public sessions;

    event PlayerJoined(address indexed player, uint8 team, uint32 rosterVersion);
    event PlayerLeft(address indexed player, uint32 rosterVersion);
    event PlayerReady(address indexed player, uint32 rosterVersion, bytes32 rulesHash);
    event MatchStarted(bytes32 indexed matchId, uint64 startAt, uint64 endAt, bytes32 rulesHash);
    event MatchCancelled(bytes32 indexed matchId);
    event SessionUpdated(address indexed player, address key, uint64 expiresAt, uint32 version, uint8 allowedActions);
    event ActionResolved(
        address indexed player,
        uint64 indexed nonce,
        ActionType action,
        uint8 tile,
        uint32 cellAfter,
        uint16 effectiveChange,
        uint16 energyAfter,
        uint64 power1,
        uint64 power2,
        uint64 timestamp
    );
    event MatchSettled(uint16 score1, uint16 score2, uint8 winner, bytes32 boardHash, uint64 endAt);

    constructor(bytes32 id) {
        if (id == bytes32(0)) revert InvalidMatchId();
        creator = msg.sender;
        matchId = id;
        createdAt = uint64(block.timestamp);
        _writeCell(21, pack(Kind.Reactor, 1, 1));
        _writeCell(22, pack(Kind.Relay, 1, 100));
        _writeCell(26, pack(Kind.Relay, 2, 100));
        _writeCell(27, pack(Kind.Reactor, 2, 1));
        power1 = (uint64(1) << 21) | (uint64(1) << 22);
        power2 = (uint64(1) << 26) | (uint64(1) << 27);
    }

    function phase() public view returns (Phase) {
        if (cancelled) return Phase.Cancelled;
        if (finished) return Phase.Finished;
        if (startAt == 0) return Phase.Waiting;
        if (block.timestamp < startAt) return Phase.Countdown;
        if (block.timestamp < endAt) return Phase.Active;
        return Phase.AwaitingSettlement;
    }

    function join(uint8 team) external {
        _waiting();
        if (team != 1 && team != 2) revert InvalidTeam();
        if (players[msg.sender].team != 0) revert AlreadyJoined();
        if (seats[team - 1] != address(0)) revert SeatOccupied();
        seats[team - 1] = msg.sender;
        players[msg.sender].team = team;
        players[msg.sender].energy = INITIAL_ENERGY;
        _invalidateReady();
        emit PlayerJoined(msg.sender, team, rosterVersion);
    }

    function leave() external {
        _waiting();
        Player storage p = players[msg.sender];
        if (p.team == 0) revert NotPlayer();
        seats[p.team - 1] = address(0);
        // Preserve nonce and monotonically increasing session version across a rejoin.
        p.team = 0;
        p.ready = false;
        _revoke(msg.sender);
        _invalidateReady();
        emit PlayerLeft(msg.sender, rosterVersion);
    }

    function setReady(uint32 roster, bytes32 rules) external {
        _waiting();
        if (players[msg.sender].team == 0) revert NotPlayer();
        if (roster != rosterVersion) revert StaleRoster();
        if (rules != RULES_HASH) revert InvalidRules();
        players[msg.sender].ready = true;
        emit PlayerReady(msg.sender, roster, rules);
    }

    function start() external {
        _waiting();
        for (uint256 i; i < 2; ++i) {
            if (seats[i] == address(0) || !players[seats[i]].ready) revert NotReady();
        }
        startAt = uint64(block.timestamp) + COUNTDOWN;
        endAt = startAt + DURATION;
        scoreAt = startAt;
        for (uint256 i; i < 2; ++i) {
            Player storage p = players[seats[i]];
            p.energy = INITIAL_ENERGY;
            p.energyAt = startAt;
            p.nextActionAt = startAt;
        }
        emit MatchStarted(matchId, startAt, endAt, RULES_HASH);
    }

    function cancel() external {
        if (startAt != 0 || cancelled) revert WrongPhase();
        if (msg.sender != creator && block.timestamp < uint256(createdAt) + WAITING_TTL) revert Unauthorized();
        cancelled = true;
        emit MatchCancelled(matchId);
    }

    function authorizeSession(address key, uint64 expiresAt, uint8 allowedActions) external {
        if (players[msg.sender].team == 0) revert NotPlayer();
        if (cancelled || finished || (endAt != 0 && block.timestamp >= endAt)) revert WrongPhase();
        if (
            key == address(0) || key == msg.sender || expiresAt <= block.timestamp || allowedActions == 0
                || allowedActions > 7
        ) {
            revert InvalidSession();
        }
        Session storage s = sessions[msg.sender];
        ++s.version;
        s.key = key;
        s.expiresAt = expiresAt;
        s.allowedActions = allowedActions;
        emit SessionUpdated(msg.sender, key, expiresAt, s.version, allowedActions);
    }

    function revokeSession() external {
        if (players[msg.sender].team == 0) revert NotPlayer();
        _revoke(msg.sender);
    }

    function act(ActionType action, uint8 tile, Kind kind, uint64 nonce) external {
        _act(msg.sender, action, tile, kind, nonce);
    }

    /// @notice Relayers submit an EIP-712 action signed by a bounded game session.
    function actSigned(Action calldata a, bytes calldata signature) external {
        Session memory s = sessions[a.player];
        if (block.timestamp > a.deadline) revert ExpiredAction();
        if (
            s.key == address(0) || block.timestamp >= s.expiresAt || a.sessionVersion != s.version
                || (s.allowedActions & (uint8(1) << uint8(a.action))) == 0
        ) revert InvalidSession();
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 sigS;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            sigS := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(sigS) > HALF_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        address signer = ecrecover(actionDigest(a), v, r, sigS);
        if (signer == address(0) || signer != s.key) revert InvalidSignature();
        _act(a.player, a.action, a.tile, a.kind, a.nonce);
    }

    function actionDigest(Action memory a) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("NadWars"), keccak256("0.1"), block.chainid, address(this))
        );
        bytes32 body = keccak256(
            abi.encode(
                ACTION_TYPEHASH,
                matchId,
                RULES_HASH,
                a.player,
                a.nonce,
                a.deadline,
                a.sessionVersion,
                uint8(a.action),
                a.tile,
                uint8(a.kind)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, body));
    }

    function finalize() external returns (uint16 score1, uint16 score2, uint8 winner) {
        if (cancelled || startAt == 0 || block.timestamp < endAt) revert WrongPhase();
        if (!finished) {
            _settle();
            finished = true;
            emit MatchSettled(storedScore1, storedScore2, _winner(), boardHash(), endAt);
        }
        return (storedScore1, storedScore2, _winner());
    }

    function scores() public view returns (uint16 score1, uint16 score2) {
        score1 = storedScore1;
        score2 = storedScore2;
        if (startAt == 0 || block.timestamp <= startAt || finished) return (score1, score2);
        uint64 t = uint64(block.timestamp < endAt ? block.timestamp : endAt);
        uint64 dt = t - scoreAt;
        score1 += uint16(dt * HexGrid.objectives(power1));
        score2 += uint16(dt * HexGrid.objectives(power2));
    }

    function energyOf(address who) public view returns (uint16) {
        Player memory p = players[who];
        if (p.team == 0) return 0;
        if (startAt == 0 || block.timestamp <= startAt) return p.energy;
        uint256 t = block.timestamp < endAt ? block.timestamp : endAt;
        uint256 e = uint256(p.energy) + (t - p.energyAt) * ENERGY_PER_SECOND;
        return uint16(e > MAX_ENERGY ? MAX_ENERGY : e);
    }

    function playerState(address who) external view returns (Player memory) {
        return players[who];
    }

    function cell(uint8 tile) public view returns (Kind kind, uint8 team, uint16 hp, bool powered) {
        if (tile >= 49) revert InvalidTile();
        uint32 value = _readCell(tile);
        (kind, team, hp) = unpack(value);
        powered = team != 0 && (((team == 1 ? power1 : power2) >> tile) & 1) != 0;
    }

    function board() public view returns (uint32[49] memory values) {
        for (uint8 i; i < 49; ++i) {
            values[i] = _readCell(i);
        }
    }

    function boardHash() public view returns (bytes32) {
        return keccak256(abi.encode(board()));
    }

    function neighborMask(uint8 tile) external pure returns (uint64) {
        if (tile >= 49) revert InvalidTile();
        return HexGrid.neighbors(uint64(1) << tile);
    }

    function storageSlot(uint8 tile) external pure returns (bytes32) {
        if (tile >= 49) revert InvalidTile();
        return bytes32(_cellSlot(tile));
    }

    function _act(address who, ActionType action, uint8 tile, Kind buildKind, uint64 nonce) internal {
        if (phase() != Phase.Active) revert WrongPhase();
        Player storage p = players[who];
        if (p.team == 0) revert NotPlayer();
        if (nonce != p.nonce) revert WrongNonce();
        if (block.timestamp < p.nextActionAt) revert CoolingDown();
        if (tile >= 49) revert InvalidTile();
        uint32[49] memory values = board();
        (Kind oldKind, uint8 oldTeam, uint16 oldHp) = unpack(values[tile]);
        uint64 ownPower = p.team == 1 ? power1 : power2;
        uint64 neighbors = HexGrid.neighbors(uint64(1) << tile);
        uint16 cost;
        uint16 effective;
        uint32 afterCell;

        if (action == ActionType.Build) {
            if (oldKind != Kind.Empty) revert InvalidTarget();
            if (HexGrid.isObjective(tile)) {
                if (buildKind != Kind.Objective) revert InvalidKind();
            } else if (buildKind != Kind.Relay && buildKind != Kind.Turret && buildKind != Kind.Shield) {
                revert InvalidKind();
            }
            if ((neighbors & ownPower) == 0) revert NotConnected();
            cost = buildKind == Kind.Relay ? 15 : buildKind == Kind.Objective ? 20 : buildKind == Kind.Turret ? 35 : 30;
            effective = maxHp(buildKind);
            afterCell = pack(buildKind, p.team, effective);
        } else {
            if (buildKind != Kind.Empty) revert InvalidKind();
            if (oldKind == Kind.Empty || oldKind == Kind.Reactor) revert InvalidTarget();
            if (action == ActionType.Attack) {
                if (oldTeam == p.team) revert InvalidTarget();
                if ((neighbors & ownPower) == 0) revert NotConnected();
                uint64 enemyPower = p.team == 1 ? power2 : power1;
                uint16 damage = 35;
                if (_hasKind(values, neighbors & ownPower, Kind.Turret)) damage += 10;
                if (_hasKind(values, (neighbors | (uint64(1) << tile)) & enemyPower, Kind.Shield)) damage -= 10;
                effective = oldHp < damage ? oldHp : damage;
                cost = 18;
                afterCell = oldHp == effective ? 0 : pack(oldKind, oldTeam, oldHp - effective);
            } else {
                if (oldTeam != p.team || oldHp == maxHp(oldKind)) revert InvalidTarget();
                if (((neighbors | (uint64(1) << tile)) & ownPower) == 0) revert NotConnected();
                uint16 missing = maxHp(oldKind) - oldHp;
                effective = missing < 30 ? missing : 30;
                cost = 12;
                afterCell = pack(oldKind, oldTeam, oldHp + effective);
            }
        }

        uint16 available = energyOf(who);
        if (available < cost) revert InsufficientEnergy();
        _settle(); // Integrate the OLD power rates before the topology changes.
        p.energy = available - cost;
        p.energyAt = uint64(block.timestamp);
        p.nextActionAt = uint64(block.timestamp) + COOLDOWN;
        ++p.nonce;
        values[tile] = afterCell;
        _writeCell(tile, afterCell);
        _recompute(values);
        emit ActionResolved(
            who, nonce, action, tile, afterCell, effective, p.energy, power1, power2, uint64(block.timestamp)
        );
    }

    function _recompute(uint32[49] memory values) internal {
        uint64 owned1;
        uint64 owned2;
        for (uint8 i; i < 49; ++i) {
            (, uint8 team, uint16 hp) = unpack(values[i]);
            if (hp == 0) continue;
            if (team == 1) owned1 |= uint64(1) << i;
            else if (team == 2) owned2 |= uint64(1) << i;
        }
        power1 = HexGrid.connected(owned1, 21);
        power2 = HexGrid.connected(owned2, 27);
    }

    function _hasKind(uint32[49] memory values, uint64 mask, Kind kind) private pure returns (bool) {
        for (uint8 i; i < 49; ++i) {
            if (((mask >> i) & 1) != 0 && Kind(uint8(values[i])) == kind) return true;
        }
        return false;
    }

    function _settle() internal {
        (storedScore1, storedScore2) = scores();
        scoreAt = uint64(block.timestamp < endAt ? block.timestamp : endAt);
    }

    function _winner() private view returns (uint8) {
        return storedScore1 == storedScore2 ? 0 : storedScore1 > storedScore2 ? 1 : 2;
    }

    function _waiting() private view {
        if (startAt != 0 || cancelled || block.timestamp >= uint256(createdAt) + WAITING_TTL) revert WrongPhase();
    }

    function _invalidateReady() private {
        ++rosterVersion;
        for (uint256 i; i < 2; ++i) {
            if (seats[i] != address(0)) players[seats[i]].ready = false;
        }
    }

    function _revoke(address who) private {
        Session storage s = sessions[who];
        ++s.version;
        s.key = address(0);
        s.expiresAt = 0;
        s.allowedActions = 0;
        emit SessionUpdated(who, address(0), 0, s.version, 0);
    }

    function maxHp(Kind kind) public pure returns (uint16) {
        if (kind == Kind.Relay || kind == Kind.Objective) return 100;
        if (kind == Kind.Turret || kind == Kind.Shield) return 120;
        return kind == Kind.Reactor ? 1 : 0;
    }

    function pack(Kind kind, uint8 team, uint16 hp) internal pure returns (uint32) {
        return uint32(uint8(kind)) | (uint32(team) << 8) | (uint32(hp) << 16);
    }

    function unpack(uint32 value) internal pure returns (Kind kind, uint8 team, uint16 hp) {
        return (Kind(uint8(value)), uint8(value >> 8), uint16(value >> 16));
    }

    function _readCell(uint8 tile) internal view returns (uint32 value) {
        uint256 slot = _cellSlot(tile);
        assembly ("memory-safe") { value := sload(slot) }
    }

    function _writeCell(uint8 tile, uint32 value) internal {
        uint256 slot = _cellSlot(tile);
        assembly ("memory-safe") { sstore(slot, value) }
    }
    function _cellSlot(uint8 tile) internal pure virtual returns (uint256);
}
