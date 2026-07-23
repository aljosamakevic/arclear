// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ManifestMerkle} from "../src/lib/ManifestMerkle.sol";

/// External wrapper so vm.expectRevert can observe rootOf's UnsortedLeaves
/// (internal library calls are inlined and invisible to expectRevert).
contract ManifestMerkleHarness {
    function rootOf(bytes32[] memory ids) external pure returns (bytes32) {
        return ManifestMerkle.rootOf(ids);
    }
}

contract ManifestMerkleTest is Test {
    ManifestMerkleHarness internal harness;

    function setUp() public {
        harness = new ManifestMerkleHarness();
    }

    // ---------------------------------------------------------------- helpers

    /// Leaf hash per the locked spec: keccak256(0x00 || id).
    function _leafHash(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), id));
    }

    /// Node hash per the locked spec: keccak256(0x01 || left || right), ordered.
    function _nodeHash(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), l, r));
    }

    /// n strictly-ascending pseudo-random bytes32 ids (insertion sort; keccak
    /// outputs over distinct inputs are unique for all practical purposes).
    function _sortedIds(uint256 n, uint256 seed) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            bytes32 v = keccak256(abi.encode(seed, i));
            uint256 j = i;
            while (j > 0 && ids[j - 1] > v) {
                ids[j] = ids[j - 1];
                --j;
            }
            ids[j] = v;
        }
    }

    /// Sibling path for walking `level` (already-hashed nodes) up to its root,
    /// mirroring the spec's promotion schedule. Shared by the honest proof
    /// builder and the node-as-leaf attack constructor.
    function _proofPath(bytes32[] memory level, uint256 index)
        internal
        pure
        returns (bytes32[] memory siblings)
    {
        bytes32[] memory buf = new bytes32[](64);
        uint256 s;
        uint256 i = index;
        uint256 w = level.length;
        bytes32[] memory cur = level;
        while (w > 1) {
            if (i & 1 == 1) {
                buf[s] = cur[i - 1];
                ++s;
            } else if (i != w - 1) {
                buf[s] = cur[i + 1];
                ++s;
            }
            uint256 nw = (w + 1) >> 1;
            bytes32[] memory next = new bytes32[](nw);
            for (uint256 j; j < w >> 1; ++j) {
                next[j] = _nodeHash(cur[2 * j], cur[2 * j + 1]);
            }
            if (w & 1 == 1) next[nw - 1] = cur[w - 1]; // promotion (D-03)
            cur = next;
            i >>= 1;
            w = nw;
        }
        siblings = new bytes32[](s);
        for (uint256 k; k < s; ++k) {
            siblings[k] = buf[k];
        }
    }

    /// Leaf-hash level 0 of a sorted id list.
    function _leafLevel(bytes32[] memory ids) internal pure returns (bytes32[] memory level) {
        level = new bytes32[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            level[i] = _leafHash(ids[i]);
        }
    }

    /// Honest inclusion proof for ids[index], built natively in Solidity so
    /// fuzz tests can generate and then tamper with valid proofs.
    function _inclusionProof(bytes32[] memory ids, uint256 index)
        internal
        pure
        returns (ManifestMerkle.InclusionProof memory p)
    {
        p = ManifestMerkle.InclusionProof({
            leaf: ids[index],
            index: index,
            leafCount: ids.length,
            siblings: _proofPath(_leafLevel(ids), index)
        });
    }

    /// Zeroed proof for the unused `b` slot of non-bracket kinds.
    function _emptyProof() internal pure returns (ManifestMerkle.InclusionProof memory p) {
        p = ManifestMerkle.InclusionProof({
            leaf: bytes32(0),
            index: 0,
            leafCount: 0,
            siblings: new bytes32[](0)
        });
    }

    // ------------------------------------------------------------- rootOf

    function test_rootOf_emptyIsSentinel() public pure {
        bytes32 root = ManifestMerkle.rootOf(new bytes32[](0));
        assertEq(root, keccak256(""), "empty manifest must hash to the v1 sentinel");
        assertEq(root, ManifestMerkle.EMPTY_ROOT, "EMPTY_ROOT constant must equal the sentinel");
    }

    function test_rootOf_singleLeaf() public pure {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256("only");
        assertEq(
            ManifestMerkle.rootOf(ids),
            keccak256(abi.encodePacked(bytes1(0x00), ids[0])),
            "single-leaf root must be the prefixed leaf hash"
        );
    }

    function test_revert_rootOf_unsorted() public {
        bytes32[] memory ids = _sortedIds(3, 1);
        (ids[1], ids[2]) = (ids[2], ids[1]); // descending pair at index 2
        vm.expectRevert(abi.encodeWithSelector(ManifestMerkle.UnsortedLeaves.selector, 2));
        harness.rootOf(ids);
    }

    function test_revert_rootOf_duplicate() public {
        bytes32[] memory ids = _sortedIds(3, 2);
        ids[1] = ids[0]; // duplicate at index 1
        vm.expectRevert(abi.encodeWithSelector(ManifestMerkle.UnsortedLeaves.selector, 1));
        harness.rootOf(ids);
    }

    // ------------------------------------------------------ verifyInclusion

    function test_verifyInclusion_validProof() public pure {
        bytes32[] memory ids = _sortedIds(5, 3);
        bytes32 root = ManifestMerkle.rootOf(ids);
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(
                ManifestMerkle.verifyInclusion(_inclusionProof(ids, i), root),
                "honest proof must verify"
            );
        }
    }

    function test_verifyInclusion_indexOutOfRange_false() public pure {
        bytes32[] memory ids = _sortedIds(4, 4);
        bytes32 root = ManifestMerkle.rootOf(ids);
        ManifestMerkle.InclusionProof memory p = _inclusionProof(ids, 1);
        p.index = p.leafCount; // index >= leafCount
        assertFalse(ManifestMerkle.verifyInclusion(p, root), "index >= leafCount must fail");
    }

    function test_verifyInclusion_wrongSiblingCount_false() public pure {
        bytes32[] memory ids = _sortedIds(4, 5);
        bytes32 root = ManifestMerkle.rootOf(ids);

        // too few siblings: truncate — must return false, never revert
        ManifestMerkle.InclusionProof memory p = _inclusionProof(ids, 0);
        bytes32[] memory fewer = new bytes32[](p.siblings.length - 1);
        for (uint256 i; i < fewer.length; ++i) {
            fewer[i] = p.siblings[i];
        }
        p.siblings = fewer;
        assertFalse(ManifestMerkle.verifyInclusion(p, root), "too few siblings must fail");

        // too many siblings: append junk — unconsumed sibling must fail
        ManifestMerkle.InclusionProof memory q = _inclusionProof(ids, 0);
        bytes32[] memory more = new bytes32[](q.siblings.length + 1);
        for (uint256 i; i < q.siblings.length; ++i) {
            more[i] = q.siblings[i];
        }
        more[more.length - 1] = keccak256("junk");
        q.siblings = more;
        assertFalse(ManifestMerkle.verifyInclusion(q, root), "unconsumed sibling must fail");
    }

    function test_verifyInclusion_tamperedSibling_false() public pure {
        bytes32[] memory ids = _sortedIds(8, 6);
        bytes32 root = ManifestMerkle.rootOf(ids);
        ManifestMerkle.InclusionProof memory p = _inclusionProof(ids, 3);
        p.siblings[0] = p.siblings[0] ^ bytes32(uint256(1));
        assertFalse(ManifestMerkle.verifyInclusion(p, root), "tampered sibling must fail");
    }

    function test_verifyInclusion_wrongRoot_false() public pure {
        bytes32[] memory ids = _sortedIds(5, 7);
        ManifestMerkle.InclusionProof memory p = _inclusionProof(ids, 2);
        assertFalse(
            ManifestMerkle.verifyInclusion(p, keccak256("not-the-root")),
            "wrong root must fail"
        );
    }

    // --------------------------------------------------- verifyNonInclusion

    function test_verifyNonInclusion_sentinelAlwaysTrue() public pure {
        // Empty manifest: any id is absent; proof content is irrelevant.
        ManifestMerkle.NonInclusionProof memory p = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.Bracket,
            a: _emptyProof(),
            b: _emptyProof()
        });
        assertTrue(
            ManifestMerkle.verifyNonInclusion(keccak256("anything"), p, ManifestMerkle.EMPTY_ROOT),
            "sentinel root must short-circuit to true"
        );
    }

    function test_verifyNonInclusion_memberIdFails() public pure {
        bytes32[] memory ids = _sortedIds(5, 8);
        bytes32 root = ManifestMerkle.rootOf(ids);

        // BelowFirst offered for the first leaf itself: strict `<` must fail.
        ManifestMerkle.NonInclusionProof memory below = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.BelowFirst,
            a: _inclusionProof(ids, 0),
            b: _emptyProof()
        });
        assertFalse(
            ManifestMerkle.verifyNonInclusion(ids[0], below, root),
            "member id must fail BelowFirst"
        );

        // AboveLast offered for the last leaf itself: strict `>` must fail.
        ManifestMerkle.NonInclusionProof memory above = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.AboveLast,
            a: _inclusionProof(ids, ids.length - 1),
            b: _emptyProof()
        });
        assertFalse(
            ManifestMerkle.verifyNonInclusion(ids[ids.length - 1], above, root),
            "member id must fail AboveLast"
        );

        // Bracket offered where id equals either neighbor: strict bounds fail.
        ManifestMerkle.NonInclusionProof memory bracket = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.Bracket,
            a: _inclusionProof(ids, 1),
            b: _inclusionProof(ids, 2)
        });
        assertFalse(
            ManifestMerkle.verifyNonInclusion(ids[1], bracket, root),
            "member id equal to lower neighbor must fail Bracket"
        );
        assertFalse(
            ManifestMerkle.verifyNonInclusion(ids[2], bracket, root),
            "member id equal to upper neighbor must fail Bracket"
        );
    }

    function test_verifyNonInclusion_bracketRequiresAdjacency() public pure {
        bytes32[] memory ids = _sortedIds(5, 9);
        bytes32 root = ManifestMerkle.rootOf(ids);

        // Skip a leaf: a at 1, b at 3 — both proofs honest, adjacency violated.
        ManifestMerkle.NonInclusionProof memory gap = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.Bracket,
            a: _inclusionProof(ids, 1),
            b: _inclusionProof(ids, 3)
        });
        assertFalse(
            ManifestMerkle.verifyNonInclusion(ids[2], gap, root),
            "non-adjacent bracket must fail even for a truly bracketed id"
        );

        // Unequal leafCounts: b claims a different manifest size.
        ManifestMerkle.NonInclusionProof memory sized = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.Bracket,
            a: _inclusionProof(ids, 1),
            b: _inclusionProof(ids, 2)
        });
        sized.b.leafCount = sized.b.leafCount + 1;
        // overflow-safe strict midpoint: a + (b - a) / 2 (index arithmetic, not protocol math)
        bytes32 mid = bytes32(uint256(ids[1]) + ((uint256(ids[2]) - uint256(ids[1])) >> 1));
        assertFalse(
            ManifestMerkle.verifyNonInclusion(mid, sized, root),
            "bracket with unequal leafCounts must fail"
        );
    }
}
