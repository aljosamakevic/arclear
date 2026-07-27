// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./RoundBuilder.sol";
import {ClearingHubV3} from "../../src/ClearingHubV3.sol";
import {ManifestMerkle} from "../../src/lib/ManifestMerkle.sol";

/// @dev V3 test harness. Differs from RoundBuilderV2 in the three places V3
///      differs from V2:
///
///      1. Manifests are `ConsumedRef[]` (id + the two participant indices), and
///         the merkle leaf is the PARTY-BOUND `manifestLeafId(id, a, b)` rather
///         than the raw id. `_leafId` mirrors that derivation locally — the
///         mirror is asserted byte-equal to the on-chain `manifestLeafId` in
///         ClearingHubV3.t.sol, which is the same dual-implementation discipline
///         the merkle library and the EIP-712 digests already use. Refs must be
///         sorted by DERIVED LEAF, not by id, because that is what rootOf sees.
///
///      2. There is no proof machinery at all. V2's root ring, coverage rule and
///         non-inclusion proof set are gone, so the V2 harness's `_proofsFor` /
///         `_nonInclusion` / `_inclusionProof` and its per-round manifest replay
///         log have no counterpart here — `redeemIOU` takes only the IOU and the
///         debtor's signature. (`ManifestMerkle`'s proof functions are still
///         exercised directly by ManifestMerkle.t.sol and MerkleParity.t.sol.)
///
///      3. `_executeRoundWithout` cannot use an empty manifest with an all-zero
///         delta vector — V3's `EmptyRound` guard rejects exactly that shape —
///         and, since WR-11 means only participants who actually settle refresh
///         `lastRound`, the filler manifest is what makes these rounds advance
///         anyone's liveness marker at all.
abstract contract RoundBuilderV3 is Test {
    ClearingHubV3 internal hub;
    MockUSDC internal usdc;

    // Deploy default matching DeployV3 (UNCALIBRATED, D-08).
    uint64 internal constant K = 3;

    uint256 internal constant ACTORS = 5;
    uint256[] internal keys;
    address[] internal actors; // sorted ascending by address

    function _setUpActors() internal {
        usdc = new MockUSDC();
        hub = new ClearingHubV3(usdc, K);

        // Derive actors, then sort (participants must be strictly ascending).
        uint256[] memory ks = new uint256[](ACTORS);
        address[] memory as_ = new address[](ACTORS);
        for (uint256 i; i < ACTORS; ++i) {
            ks[i] = uint256(keccak256(abi.encode("arclear-actor", i)));
            as_[i] = vm.addr(ks[i]);
        }
        for (uint256 i; i < ACTORS; ++i) {
            for (uint256 j = i + 1; j < ACTORS; ++j) {
                if (as_[j] < as_[i]) {
                    (as_[i], as_[j]) = (as_[j], as_[i]);
                    (ks[i], ks[j]) = (ks[j], ks[i]);
                }
            }
        }
        for (uint256 i; i < ACTORS; ++i) {
            keys.push(ks[i]);
            actors.push(as_[i]);
        }
    }

    function _fundAndDeposit(address actor, uint256 amount) internal {
        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(hub), amount);
        hub.deposit(amount);
        vm.stopPrank();
    }

    function _keyOf(address actor) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == actor) return keys[i];
        }
        revert("unknown actor");
    }

    function _indexOf(address[] memory p, address who) internal pure returns (uint32) {
        for (uint256 i; i < p.length; ++i) {
            if (p[i] == who) return uint32(i);
        }
        revert("not a participant");
    }

    // ------------------------------------------------------------- manifests

    /// @dev Local mirror of ClearingHubV3.manifestLeafId (parity-asserted).
    function _leafId(bytes32 id, address a, address b) internal pure returns (bytes32) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(id, lo, hi));
    }

    /// @dev The ledger key / manifest leaf for a whole IOU.
    function _leafOf(ClearingHubV3.Iou memory iou) internal view returns (bytes32) {
        return _leafId(hub.hashIou(iou), iou.debtor, iou.creditor);
    }

    /// @dev Derive the leaf vector a ref list commits, in ref order.
    function _leaves(address[] memory p, ClearingHubV3.ConsumedRef[] memory refs)
        internal
        pure
        returns (bytes32[] memory out)
    {
        out = new bytes32[](refs.length);
        for (uint256 i; i < refs.length; ++i) {
            out[i] = _leafId(refs[i].id, p[refs[i].partyAIdx], p[refs[i].partyBIdx]);
        }
    }

    /// @dev In-place insertion sort of refs by DERIVED LEAF — the order rootOf
    ///      demands. keccak-derived leaves are unique, so the result is strictly
    ///      ascending.
    function _sortRefs(address[] memory p, ClearingHubV3.ConsumedRef[] memory refs) internal pure {
        for (uint256 i = 1; i < refs.length; ++i) {
            ClearingHubV3.ConsumedRef memory cur = refs[i];
            bytes32 curLeaf = _leafId(cur.id, p[cur.partyAIdx], p[cur.partyBIdx]);
            uint256 j = i;
            while (j > 0) {
                ClearingHubV3.ConsumedRef memory prev = refs[j - 1];
                if (_leafId(prev.id, p[prev.partyAIdx], p[prev.partyBIdx]) <= curLeaf) break;
                refs[j] = prev;
                --j;
            }
            refs[j] = cur;
        }
    }

    /// @dev m deterministic refs, all attributed to participants[a]/[b], sorted
    ///      by derived leaf.
    function _manifest(address[] memory p, uint256 m, bytes32 salt, uint32 a, uint32 b)
        internal
        pure
        returns (ClearingHubV3.ConsumedRef[] memory refs)
    {
        refs = new ClearingHubV3.ConsumedRef[](m);
        for (uint256 i; i < m; ++i) {
            refs[i] = ClearingHubV3.ConsumedRef({
                id: keccak256(abi.encode(salt, i)),
                partyAIdx: a,
                partyBIdx: b
            });
        }
        _sortRefs(p, refs);
    }

    /// @dev Default attribution (participants 0 and 1).
    function _manifest(address[] memory p, uint256 m, bytes32 salt)
        internal
        pure
        returns (ClearingHubV3.ConsumedRef[] memory)
    {
        return _manifest(p, m, salt, 0, 1);
    }

    /// @dev One ref binding a real IOU id to its real parties.
    function _refFor(address[] memory p, bytes32 id, address debtor, address creditor)
        internal
        pure
        returns (ClearingHubV3.ConsumedRef memory)
    {
        return ClearingHubV3.ConsumedRef({
            id: id,
            partyAIdx: _indexOf(p, debtor),
            partyBIdx: _indexOf(p, creditor)
        });
    }

    function _noRefs() internal pure returns (ClearingHubV3.ConsumedRef[] memory) {
        return new ClearingHubV3.ConsumedRef[](0);
    }

    // ---------------------------------------------------------------- rounds

    /// @dev A(-3) B(+1) C(+2) plus a small party-bound manifest.
    function _simpleRound()
        internal
        view
        returns (address[] memory p, int256[] memory d, ClearingHubV3.ConsumedRef[] memory refs)
    {
        p = new address[](3);
        d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        refs = _manifest(p, 3, "simple-round");
    }

    /// @dev Round digest exactly as the hub derives it: root over the DERIVED
    ///      leaves, then the (parity-proven) on-chain hashRound.
    function _digestV3(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory leaves
    ) internal view returns (bytes32) {
        return hub.hashRound(nonce_, participants, deltas, ManifestMerkle.rootOf(leaves));
    }

    function _signRound(
        uint256 pk,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory leaves
    ) internal view returns (bytes memory) {
        bytes32 digest = _digestV3(nonce_, participants, deltas, leaves);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build every participant's consent over the leaf-derived digest.
    function _buildSignatures(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory leaves
    ) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](participants.length);
        for (uint256 i; i < participants.length; ++i) {
            sigs[i] = _signRound(_keyOf(participants[i]), nonce_, participants, deltas, leaves);
        }
    }

    /// @dev Same, taking refs (derives the leaves first).
    function _buildSignatures(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal view returns (bytes[] memory) {
        return _buildSignatures(nonce_, participants, deltas, _leaves(participants, refs));
    }

    /// @dev Sign + execute.
    function _execute(
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal {
        uint64 nonce_ = hub.roundNonce();
        bytes[] memory sigs = _buildSignatures(nonce_, participants, deltas, refs);
        hub.executeRound(nonce_, participants, deltas, refs, sigs);
    }

    /// @dev Advance the ON-CHAIN staleness clock (Pitfall 4: eligibility is
    ///      executed-rounds-without-settling, never coordinator counters): an
    ///      all-zero-delta round among every actor EXCEPT `absent`. Zero deltas
    ///      need no collateral; filtered actors stay ascending because `actors`
    ///      already is.
    ///
    ///      Carries one fabricated ref per round: V3's EmptyRound guard rejects
    ///      zero-delta + empty-manifest rounds, and under WR-11 a participant
    ///      with neither a delta nor an attributed ref would not refresh
    ///      `lastRound` anyway. Salted by nonce so no leaf is ever reused (the
    ///      consumption ledger rejects that).
    function _executeRoundWithout(address absent) internal {
        _executeRoundWithout(absent, 1);
    }

    /// @dev Same, with `m` fabricated refs instead of one.
    function _executeRoundWithout(address absent, uint256 m) internal {
        address[] memory p = _presentActors(absent);
        _execute(
            p,
            new int256[](p.length),
            _manifest(p, m, keccak256(abi.encode("filler", hub.roundNonce())))
        );
    }

    /// @dev Same, with a caller-chosen manifest.
    function _executeRoundWithout(address absent, ClearingHubV3.ConsumedRef[] memory refs)
        internal
    {
        address[] memory p = _presentActors(absent);
        _execute(p, new int256[](p.length), refs);
    }

    /// @dev A round that refreshes `lastRound` for EVERY present actor: one
    ///      fabricated ref per adjacent pair, so nobody is left unattributed
    ///      (WR-11). Used where a test needs the whole set marked live.
    function _executeRoundRefreshingAll(address absent) internal {
        address[] memory p = _presentActors(absent);
        uint256 pairs = p.length - 1;
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](pairs);
        bytes32 salt = keccak256(abi.encode("refresh-all", hub.roundNonce()));
        for (uint256 i; i < pairs; ++i) {
            refs[i] = ClearingHubV3.ConsumedRef({
                id: keccak256(abi.encode(salt, i)),
                partyAIdx: uint32(i),
                partyBIdx: uint32(i + 1)
            });
        }
        _sortRefs(p, refs);
        _execute(p, new int256[](p.length), refs);
    }

    function _presentActors(address absent) internal view returns (address[] memory p) {
        uint256 count;
        for (uint256 i; i < ACTORS; ++i) {
            if (actors[i] != absent) ++count;
        }
        p = new address[](count);
        uint256 j;
        for (uint256 i; i < ACTORS; ++i) {
            if (actors[i] != absent) p[j++] = actors[i];
        }
    }

    // ------------------------------------------------------------------ ious

    /// @dev Convenience IOU. V3 has no MAX_IOU_LIFETIME and no coverage rule, so
    ///      expiry no longer participates in redemption eligibility at all; the
    ///      one-day default is kept purely so the off-chain netting convention
    ///      (src/iou.ts) stays represented in the fixtures.
    function _makeIou(address debtor, address creditor, uint256 amount, uint256 nonce)
        internal
        view
        returns (ClearingHubV3.Iou memory)
    {
        return _makeIou(debtor, creditor, amount, nonce, uint64(block.timestamp) + 86400);
    }

    function _makeIou(address debtor, address creditor, uint256 amount, uint256 nonce, uint64 expiry)
        internal
        pure
        returns (ClearingHubV3.Iou memory)
    {
        return ClearingHubV3.Iou({
            debtor: debtor,
            creditor: creditor,
            amount: amount,
            nonce: nonce,
            expiry: expiry,
            ref: keccak256(abi.encode("ref", nonce))
        });
    }

    /// @dev Mirrors ClearingHubV3.hashIou for memory structs — same EIP-712
    ///      domain recipe as RoundBuilder._digest ("ArcClearingHub", "1",
    ///      block.chainid, address(hub)) with the IOU typehash.
    function _iouDigest(ClearingHubV3.Iou memory iou) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "IOU(address debtor,address creditor,uint256 amount,uint256 nonce,uint64 expiry,bytes32 ref)"
                ),
                iou.debtor,
                iou.creditor,
                iou.amount,
                iou.nonce,
                iou.expiry,
                iou.ref
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ArcClearingHub")),
                keccak256(bytes("1")),
                block.chainid,
                address(hub)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _signIou(uint256 pk, ClearingHubV3.Iou memory iou)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _iouDigest(iou));
        return abi.encodePacked(r, s, v);
    }
}
