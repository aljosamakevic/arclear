// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./RoundBuilder.sol";
import {ClearingHubV2} from "../../src/ClearingHubV2.sol";
import {ManifestMerkle} from "../../src/lib/ManifestMerkle.sol";

/// @dev V2 test harness: known-key actors, consumedIds round assembly, IOU
///      signing via a local EIP-712 mirror, on-chain staleness advancement,
///      and full non-inclusion proof-set construction by replaying the
///      harness-tracked per-round manifests. RoundBuilder pins v1 — this is a
///      separate file so v1 tests keep the original.
abstract contract RoundBuilderV2 is Test {
    ClearingHubV2 internal hub;
    MockUSDC internal usdc;

    // Deploy defaults matching DeployV2 (UNCALIBRATED, D-08).
    uint64 internal constant K = 3;
    uint64 internal constant RING = 16;
    uint64 internal constant L = 86400;

    uint256 internal constant ACTORS = 5;
    uint256[] internal keys;
    address[] internal actors; // sorted ascending by address

    /// @dev Harness-side replay log: consumedIds of every round WE executed,
    ///      keyed by nonce — the data-availability mirror _proofsFor replays.
    mapping(uint64 => bytes32[]) internal roundIdsOf;

    function _setUpActors() internal {
        usdc = new MockUSDC();
        hub = new ClearingHubV2(usdc, K, RING, L);

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

    // ------------------------------------------------------------- manifests

    /// @dev In-place insertion sort; keccak-derived ids are unique, so sorted
    ///      output is strictly ascending as executeRound requires.
    function _sort(bytes32[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; ++i) {
            bytes32 k = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > k) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = k;
        }
    }

    /// @dev m deterministic, strictly-ascending pseudo-IOU ids.
    function _manifest(uint256 m, bytes32 salt) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](m);
        for (uint256 i; i < m; ++i) {
            ids[i] = keccak256(abi.encode(salt, i));
        }
        _sort(ids);
    }

    // ---------------------------------------------------------------- rounds

    /// @dev A(-3) B(+1) C(+2) plus a small strictly-ascending consumedIds set.
    function _simpleRound()
        internal
        view
        returns (address[] memory p, int256[] memory d, bytes32[] memory ids)
    {
        p = new address[](3);
        d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        ids = _manifest(3, "simple-round");
    }

    /// @dev Round digest exactly as the hub derives it: root from consumedIds,
    ///      then the (parity-proven) on-chain hashRound.
    function _digestV2(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory consumedIds
    ) internal view returns (bytes32) {
        return hub.hashRound(nonce_, participants, deltas, ManifestMerkle.rootOf(consumedIds));
    }

    function _signRound(
        uint256 pk,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory consumedIds
    ) internal view returns (bytes memory) {
        bytes32 digest = _digestV2(nonce_, participants, deltas, consumedIds);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build every participant's consent over the consumedIds-derived digest.
    function _buildSignatures(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory consumedIds
    ) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](participants.length);
        for (uint256 i; i < participants.length; ++i) {
            sigs[i] = _signRound(_keyOf(participants[i]), nonce_, participants, deltas, consumedIds);
        }
    }

    /// @dev Sign + execute + record the manifest for later proof replay.
    function _execute(address[] memory participants, int256[] memory deltas, bytes32[] memory ids)
        internal
    {
        uint64 nonce_ = hub.roundNonce();
        bytes[] memory sigs = _buildSignatures(nonce_, participants, deltas, ids);
        hub.executeRound(nonce_, participants, deltas, ids, sigs);
        roundIdsOf[nonce_] = ids;
    }

    /// @dev Advance the ON-CHAIN staleness clock (Pitfall 4: eligibility is
    ///      executed-rounds-without-participation, never coordinator counters):
    ///      an all-zero-delta round among every actor EXCEPT `absent`, empty
    ///      manifest. Zero deltas need no collateral; filtered actors stay
    ///      ascending because `actors` already is.
    function _executeRoundWithout(address absent) internal {
        _executeRoundWithout(absent, new bytes32[](0));
    }

    /// @dev Same, with a caller-chosen manifest (must not overlap redeemed ids).
    function _executeRoundWithout(address absent, bytes32[] memory ids) internal {
        uint256 count;
        for (uint256 i; i < ACTORS; ++i) {
            if (actors[i] != absent) ++count;
        }
        address[] memory p = new address[](count);
        int256[] memory d = new int256[](count); // all zero: sum 0, no collateral needed
        uint256 j;
        for (uint256 i; i < ACTORS; ++i) {
            if (actors[i] != absent) p[j++] = actors[i];
        }
        _execute(p, d, ids);
    }

    // ------------------------------------------------------------------ ious

    /// @dev Convenience IOU honoring the L-convention default
    ///      (expiry <= block.timestamp + L, enforced off-chain in signIou).
    function _makeIou(address debtor, address creditor, uint256 amount, uint256 nonce)
        internal
        view
        returns (ClearingHubV2.Iou memory)
    {
        return _makeIou(debtor, creditor, amount, nonce, uint64(block.timestamp) + L);
    }

    function _makeIou(address debtor, address creditor, uint256 amount, uint256 nonce, uint64 expiry)
        internal
        pure
        returns (ClearingHubV2.Iou memory)
    {
        return ClearingHubV2.Iou({
            debtor: debtor,
            creditor: creditor,
            amount: amount,
            nonce: nonce,
            expiry: expiry,
            ref: keccak256(abi.encode("ref", nonce))
        });
    }

    /// @dev Mirrors ClearingHubV2.hashIou for memory structs — same EIP-712
    ///      domain recipe as RoundBuilder._digest ("ArcClearingHub", "1",
    ///      block.chainid, address(hub)) with the IOU typehash.
    function _iouDigest(ClearingHubV2.Iou memory iou) internal view returns (bytes32) {
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

    function _signIou(uint256 pk, ClearingHubV2.Iou memory iou)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _iouDigest(iou));
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------- proofs

    /// @dev The complete proof set redeemIOU demands RIGHT NOW: exactly
    ///      min(roundNonce, RING) non-inclusion proofs, positionally matched
    ///      to ascending buffered nonces, rebuilt from the replay log.
    function _proofsFor(bytes32 id)
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
            proofs[i] = _nonInclusion(roundIdsOf[start + uint64(i)], id);
        }
    }

    /// @dev Bracketing non-inclusion proof for one round's manifest. If `id`
    ///      IS in the manifest, returns a well-formed proof that verifies
    ///      false (strict inequalities) — never a harness revert — so tests
    ///      can prove the structural net->cannot-redeem direction.
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
