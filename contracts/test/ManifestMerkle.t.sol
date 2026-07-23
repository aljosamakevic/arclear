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

    // ------------------------------------------------- construction structure

    /// D-03 tripwire (CVE-2012-2459 class): the promotion root of {a,b,c} must
    /// differ from the Bitcoin-style duplicated-tree root node(node(a,b), node(c,c)).
    function test_rootOf_promotionNotDuplication() public pure {
        bytes32[] memory ids = _sortedIds(3, 10);
        bytes32 l0 = _leafHash(ids[0]);
        bytes32 l1 = _leafHash(ids[1]);
        bytes32 l2 = _leafHash(ids[2]);

        bytes32 promotionRoot = _nodeHash(_nodeHash(l0, l1), l2);
        assertEq(
            ManifestMerkle.rootOf(ids),
            promotionRoot,
            "3-leaf root must be node(node(l0,l1), l2) with the lone node promoted"
        );

        bytes32 duplicatedRoot = _nodeHash(_nodeHash(l0, l1), _nodeHash(l2, l2));
        assertTrue(
            promotionRoot != duplicatedRoot,
            "promotion root must differ from duplicated-odd-node root"
        );
    }

    function test_verifyInclusion_allLeaves() public pure {
        uint256[5] memory counts = [uint256(1), 2, 3, 5, 8];
        for (uint256 c; c < counts.length; ++c) {
            bytes32[] memory ids = _sortedIds(counts[c], 100 + c);
            bytes32 root = ManifestMerkle.rootOf(ids);
            for (uint256 i; i < ids.length; ++i) {
                assertTrue(
                    ManifestMerkle.verifyInclusion(_inclusionProof(ids, i), root),
                    "every leaf of every tree size must verify"
                );
            }
        }
    }

    // ------------------------------------------- non-inclusion positive paths

    function test_verifyNonInclusion_belowFirst() public pure {
        bytes32[] memory ids = _sortedIds(5, 11);
        bytes32 root = ManifestMerkle.rootOf(ids);
        ManifestMerkle.NonInclusionProof memory p = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.BelowFirst,
            a: _inclusionProof(ids, 0),
            b: _emptyProof()
        });
        assertTrue(
            ManifestMerkle.verifyNonInclusion(bytes32(uint256(ids[0]) - 1), p, root),
            "id below the first leaf must verify"
        );

        // single-leaf tree: covered by BelowFirst
        bytes32[] memory one = _sortedIds(1, 12);
        bytes32 root1 = ManifestMerkle.rootOf(one);
        ManifestMerkle.NonInclusionProof memory q = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.BelowFirst,
            a: _inclusionProof(one, 0),
            b: _emptyProof()
        });
        assertTrue(
            ManifestMerkle.verifyNonInclusion(bytes32(uint256(one[0]) - 1), q, root1),
            "single-leaf tree BelowFirst must verify"
        );
    }

    function test_verifyNonInclusion_aboveLast() public pure {
        bytes32[] memory ids = _sortedIds(5, 13);
        bytes32 root = ManifestMerkle.rootOf(ids);
        ManifestMerkle.NonInclusionProof memory p = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.AboveLast,
            a: _inclusionProof(ids, 4),
            b: _emptyProof()
        });
        assertTrue(
            ManifestMerkle.verifyNonInclusion(bytes32(uint256(ids[4]) + 1), p, root),
            "id above the last leaf must verify"
        );

        // a non-last leaf offered as "last" must fail the index gate
        ManifestMerkle.NonInclusionProof memory q = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.AboveLast,
            a: _inclusionProof(ids, 2),
            b: _emptyProof()
        });
        assertFalse(
            ManifestMerkle.verifyNonInclusion(bytes32(uint256(ids[4]) + 1), q, root),
            "AboveLast with a non-last leaf must fail"
        );
    }

    function test_verifyNonInclusion_bracket() public pure {
        bytes32[] memory ids = _sortedIds(8, 14);
        bytes32 root = ManifestMerkle.rootOf(ids);
        for (uint256 i; i + 1 < ids.length; ++i) {
            ManifestMerkle.NonInclusionProof memory p = ManifestMerkle.NonInclusionProof({
                kind: ManifestMerkle.NonInclusionKind.Bracket,
                a: _inclusionProof(ids, i),
                b: _inclusionProof(ids, i + 1)
            });
            bytes32 mid =
                bytes32(uint256(ids[i]) + ((uint256(ids[i + 1]) - uint256(ids[i])) >> 1));
            assertTrue(
                ManifestMerkle.verifyNonInclusion(mid, p, root),
                "id strictly between adjacent leaves must verify"
            );
        }
    }

    // ------------------------------------------------------- adversarial fuzz

    /// Consume-direction trace of the verification walk for (index, leafCount):
    /// one byte per consumed sibling — 0x00 left, 0x01 right; promotions emit
    /// nothing (they hash nothing, so they cannot be observed by the verifier).
    function _consumeTrace(uint256 index, uint256 count)
        internal
        pure
        returns (bytes memory trace)
    {
        uint256 i = index;
        uint256 w = count;
        while (w > 1) {
            if (i & 1 == 1) trace = abi.encodePacked(trace, uint8(0));
            else if (i != w - 1) trace = abi.encodePacked(trace, uint8(1));
            i >>= 1;
            w = (w + 1) >> 1;
        }
    }

    function testFuzz_indexLie_rejected(uint256 seed, uint256 lie) public pure {
        uint256 n = bound(seed, 2, 32);
        bytes32[] memory ids = _sortedIds(n, seed);
        bytes32 root = ManifestMerkle.rootOf(ids);
        uint256 idx = uint256(keccak256(abi.encode(seed, "i"))) % n;
        ManifestMerkle.InclusionProof memory p = _inclusionProof(ids, idx);

        uint256 lieIdx = bound(lie, 0, n - 1);
        if (lieIdx == idx) lieIdx = (lieIdx + 1) % n; // force an actual lie, keep index < leafCount
        p.index = lieIdx;
        assertFalse(ManifestMerkle.verifyInclusion(p, root), "index lie must be rejected");
    }

    function testFuzz_leafCountLie_rejected(uint256 seed, uint256 lie) public pure {
        uint256 n = bound(seed, 2, 32);
        bytes32[] memory ids = _sortedIds(n, seed);
        bytes32 root = ManifestMerkle.rootOf(ids);
        uint256 idx = uint256(keccak256(abi.encode(seed, "i"))) % n;
        ManifestMerkle.InclusionProof memory p = _inclusionProof(ids, idx);

        uint256 lieCount = bound(lie, idx + 1, n + 64); // index < leafCount still holds
        vm.assume(lieCount != n);
        // A count lie with an identical consume trace hashes exactly the same
        // bytes — it is unobservable metadata, not a forgery: it cannot change
        // the leaf, its position among the committed leaves, or any of the
        // security gates (making a leaf "last" or resizing one side of a
        // bracket always alters the trace). Only trace-changing lies are
        // adversarial, and those must always be rejected.
        vm.assume(
            keccak256(_consumeTrace(idx, lieCount)) != keccak256(_consumeTrace(idx, n))
        );
        p.leafCount = lieCount;
        assertFalse(ManifestMerkle.verifyInclusion(p, root), "leafCount lie must be rejected");
    }

    function testFuzz_siblingTamper_rejected(uint256 seed, uint256 sibPick, uint256 bitPick)
        public
        pure
    {
        uint256 n = bound(seed, 2, 32);
        bytes32[] memory ids = _sortedIds(n, seed);
        bytes32 root = ManifestMerkle.rootOf(ids);
        uint256 idx = uint256(keccak256(abi.encode(seed, "i"))) % n;
        ManifestMerkle.InclusionProof memory p = _inclusionProof(ids, idx);

        // n >= 2 guarantees every leaf consumes at least one sibling
        uint256 si = bound(sibPick, 0, p.siblings.length - 1);
        uint256 bit = bound(bitPick, 0, 255);
        p.siblings[si] = p.siblings[si] ^ bytes32(uint256(1) << bit);
        assertFalse(ManifestMerkle.verifyInclusion(p, root), "tampered sibling must be rejected");
    }

    function testFuzz_bracketAdjacencyLie_rejected(uint256 seed, uint256 pick) public pure {
        uint256 n = bound(seed, 3, 32);
        bytes32[] memory ids = _sortedIds(n, seed);
        bytes32 root = ManifestMerkle.rootOf(ids);

        // Non-adjacent neighbors: a at i, b at j >= i+2 — both proofs honest.
        // The skipped member ids[i+1] is strictly between them; only the
        // adjacency check stands between it and a false absence claim.
        uint256 i = bound(pick, 0, n - 3);
        uint256 j = bound(uint256(keccak256(abi.encode(pick, "j"))), i + 2, n - 1);
        ManifestMerkle.NonInclusionProof memory p = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.Bracket,
            a: _inclusionProof(ids, i),
            b: _inclusionProof(ids, j)
        });
        assertFalse(
            ManifestMerkle.verifyNonInclusion(ids[i + 1], p, root),
            "non-adjacent bracket must be rejected"
        );

        // Unequal leafCounts with adjacent indices must also fail.
        vm.assume(uint256(ids[i + 1]) - uint256(ids[i]) > 1);
        ManifestMerkle.NonInclusionProof memory q = ManifestMerkle.NonInclusionProof({
            kind: ManifestMerkle.NonInclusionKind.Bracket,
            a: _inclusionProof(ids, i),
            b: _inclusionProof(ids, i + 1)
        });
        q.b.leafCount = q.b.leafCount + 1 + (seed % 7);
        bytes32 mid = bytes32(uint256(ids[i]) + ((uint256(ids[i + 1]) - uint256(ids[i])) >> 1));
        assertFalse(
            ManifestMerkle.verifyNonInclusion(mid, q, root),
            "bracket with unequal leafCounts must be rejected"
        );
    }

    /// Second-preimage attack (T-02-05): offer an internal level-1 node as a
    /// "leaf" of a half-sized tree with the genuine upper-level sibling path.
    /// Without the 0x00/0x01 prefix separation this proof would verify.
    function testFuzz_nodeAsLeaf_rejected(uint256 seed) public pure {
        uint256 n = bound(seed, 2, 32);
        bytes32[] memory ids = _sortedIds(n, seed);
        bytes32 root = ManifestMerkle.rootOf(ids);

        // build level 1 exactly as the construction does
        bytes32[] memory level0 = _leafLevel(ids);
        uint256 nw = (n + 1) >> 1;
        bytes32[] memory level1 = new bytes32[](nw);
        for (uint256 j; j < n >> 1; ++j) {
            level1[j] = _nodeHash(level0[2 * j], level0[2 * j + 1]);
        }
        if (n & 1 == 1) level1[nw - 1] = level0[n - 1];

        // pick a real internal node (not a promoted leaf) and claim it is a leaf
        uint256 pos = uint256(keccak256(abi.encode(seed, "node"))) % (n >> 1);
        ManifestMerkle.InclusionProof memory p = ManifestMerkle.InclusionProof({
            leaf: level1[pos],
            index: pos,
            leafCount: nw,
            siblings: _proofPath(level1, pos)
        });
        assertFalse(
            ManifestMerkle.verifyInclusion(p, root),
            "internal node offered as leaf must be rejected"
        );
    }
}
