// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./RoundBuilder.sol";
import {ClearingHubV3} from "../../src/ClearingHubV3.sol";
import {ManifestMerkle} from "../../src/lib/ManifestMerkle.sol";

/// @dev V3 test harness. Differs from RoundBuilderV2 in exactly the two places
///      V3 differs from V2:
///
///      1. Manifests are `ConsumedRef[]` (id + the two participant indices), and
///         the merkle leaf is the PARTY-BOUND `manifestLeafId(id, a, b)` rather
///         than the raw id. `_leaves` mirrors that derivation locally — the
///         mirror is asserted byte-equal to the on-chain `manifestLeafId` in
///         ClearingHubV3.t.sol, which is the same dual-implementation discipline
///         the merkle library and the EIP-712 digests already use. Refs must be
///         sorted by DERIVED LEAF, not by id, because that is what rootOf sees.
///
///      2. `_executeRoundWithout` can no longer use an empty manifest with an
///         all-zero delta vector — V3's `EmptyRound` guard rejects exactly that
///         shape. It carries one fabricated ref per round instead, salted by
///         nonce so every buffered root is distinct.
abstract contract RoundBuilderV3 is Test {
    ClearingHubV3 internal hub;
    MockUSDC internal usdc;

    // Deploy defaults matching DeployV3 (UNCALIBRATED, D-08).
    uint64 internal constant K = 3;
    uint64 internal constant RING = 16;
    uint64 internal constant L = 86400;

    uint256 internal constant ACTORS = 5;
    uint256[] internal keys;
    address[] internal actors; // sorted ascending by address

    /// @dev Harness-side replay log: the DERIVED LEAVES of every round WE
    ///      executed, keyed by nonce — the data-availability mirror _proofsFor
    ///      replays.
    mapping(uint64 => bytes32[]) internal roundLeavesOf;

    function _setUpActors() internal {
        usdc = new MockUSDC();
        hub = new ClearingHubV3(usdc, K, RING, L);

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

    /// @dev Sign + execute + record the derived leaves for later proof replay.
    function _execute(
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal {
        uint64 nonce_ = hub.roundNonce();
        bytes32[] memory leaves = _leaves(participants, refs);
        bytes[] memory sigs = _buildSignatures(nonce_, participants, deltas, leaves);
        hub.executeRound(nonce_, participants, deltas, refs, sigs);
        roundLeavesOf[nonce_] = leaves;
    }

    /// @dev Advance the ON-CHAIN staleness clock (Pitfall 4: eligibility is
    ///      executed-rounds-without-participation, never coordinator counters):
    ///      an all-zero-delta round among every actor EXCEPT `absent`.
    ///      Zero deltas need no collateral; filtered actors stay ascending
    ///      because `actors` already is.
    ///
    ///      NOTE: unlike the V2 harness this cannot use an empty manifest —
    ///      V3's EmptyRound guard rejects zero-delta + empty-manifest rounds.
    ///      It carries one fabricated ref, salted by nonce so each buffered root
    ///      is distinct. That this remains possible at all IS the documented
    ///      CR-02 residual (see ClearingHubV3PoC.t.sol).
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

    /// @dev Same, with a caller-chosen manifest (must not overlap redeemed ids).
    function _executeRoundWithout(address absent, ClearingHubV3.ConsumedRef[] memory refs)
        internal
    {
        address[] memory p = _presentActors(absent);
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

    /// @dev Convenience IOU honoring the L-convention default
    ///      (expiry <= block.timestamp + L, enforced off-chain in signIou).
    function _makeIou(address debtor, address creditor, uint256 amount, uint256 nonce)
        internal
        view
        returns (ClearingHubV3.Iou memory)
    {
        return _makeIou(debtor, creditor, amount, nonce, uint64(block.timestamp) + L);
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

    // ---------------------------------------------------------------- proofs

    /// @dev The complete proof set redeemIOU demands RIGHT NOW for an IOU:
    ///      exactly min(roundNonce, RING) non-inclusion proofs of the IOU's
    ///      PARTY-BOUND leaf, positionally matched to ascending buffered
    ///      nonces, rebuilt from the replay log.
    function _proofsForIou(ClearingHubV3.Iou memory iou)
        internal
        view
        returns (ManifestMerkle.NonInclusionProof[] memory)
    {
        return _proofsForLeaf(_leafId(hub.hashIou(iou), iou.debtor, iou.creditor));
    }

    function _proofsForLeaf(bytes32 leaf)
        internal
        view
        returns (ManifestMerkle.NonInclusionProof[] memory proofs)
    {
        uint64 nonce_ = hub.roundNonce();
        uint64 ring = hub.RING();
        uint256 expected = nonce_ < ring ? nonce_ : ring;
        proofs = new ManifestMerkle.NonInclusionProof[](expected);
        uint64 start = nonce_ > ring ? nonce_ - ring : 0;
        for (uint256 i; i < expected; ++i) {
            proofs[i] = _nonInclusion(roundLeavesOf[start + uint64(i)], leaf);
        }
    }

    /// @dev Bracketing non-inclusion proof for one round's leaf set. If `leaf`
    ///      IS in the set, returns a well-formed proof that verifies false
    ///      (strict inequalities) — never a harness revert — so tests can prove
    ///      the structural net->cannot-redeem direction.
    function _nonInclusion(bytes32[] memory ids, bytes32 id)
        internal
        pure
        returns (ManifestMerkle.NonInclusionProof memory p)
    {
        uint256 n = ids.length;
        if (n == 0) return p; // sentinel root: contents ignored by verifier

        if (id < ids[0]) {
            p.kind = ManifestMerkle.NonInclusionKind.BelowFirst;
            p.a = _inclusionProof(ids, 0);
            return p;
        }
        if (id > ids[n - 1]) {
            p.kind = ManifestMerkle.NonInclusionKind.AboveLast;
            p.a = _inclusionProof(ids, n - 1);
            return p;
        }
        // id equals a leaf: emit the nearest well-formed-but-failing shape.
        for (uint256 i; i < n; ++i) {
            if (ids[i] == id) {
                if (n == 1) {
                    p.kind = ManifestMerkle.NonInclusionKind.AboveLast;
                    p.a = _inclusionProof(ids, 0); // id > leaf fails: id == leaf
                } else if (i + 1 < n) {
                    p.kind = ManifestMerkle.NonInclusionKind.Bracket;
                    p.a = _inclusionProof(ids, i); // a.leaf < id fails: equal
                    p.b = _inclusionProof(ids, i + 1);
                } else {
                    p.kind = ManifestMerkle.NonInclusionKind.Bracket;
                    p.a = _inclusionProof(ids, i - 1);
                    p.b = _inclusionProof(ids, i); // id < b.leaf fails: equal
                }
                return p;
            }
        }
        // strict bracket: ids[i] < id < ids[i+1]
        for (uint256 i; i + 1 < n; ++i) {
            if (ids[i] < id && id < ids[i + 1]) {
                p.kind = ManifestMerkle.NonInclusionKind.Bracket;
                p.a = _inclusionProof(ids, i);
                p.b = _inclusionProof(ids, i + 1);
                return p;
            }
        }
        revert("unreachable: sorted manifest has no bracket");
    }

    /// @dev Inclusion proof by rebuilding the tree exactly as
    ///      ManifestMerkle.rootOf does (0x00 leaf / 0x01 node prefixes,
    ///      lone-node promotion consumes no sibling, D-03).
    function _inclusionProof(bytes32[] memory ids, uint256 index)
        internal
        pure
        returns (ManifestMerkle.InclusionProof memory p)
    {
        uint256 n = ids.length;
        p.leaf = ids[index];
        p.index = index;
        p.leafCount = n;

        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            level[i] = keccak256(abi.encodePacked(bytes1(0x00), ids[i]));
        }

        bytes32[] memory sibs = new bytes32[](64); // depth bound; trimmed below
        uint256 s;
        uint256 idx = index;
        uint256 w = n;
        while (w > 1) {
            // collect the sibling BEFORE the level is overwritten in place
            if (idx & 1 == 1) {
                sibs[s++] = level[idx - 1];
            } else if (idx != w - 1) {
                sibs[s++] = level[idx + 1];
            }
            // else: lone node promotes unchanged, no sibling (D-03)

            uint256 nw = (w + 1) >> 1;
            for (uint256 j; j < w >> 1; ++j) {
                level[j] = keccak256(abi.encodePacked(bytes1(0x01), level[2 * j], level[2 * j + 1]));
            }
            if (w & 1 == 1) level[nw - 1] = level[w - 1];
            w = nw;
            idx >>= 1;
        }

        p.siblings = new bytes32[](s);
        for (uint256 i; i < s; ++i) {
            p.siblings[i] = sibs[i];
        }
    }
}
