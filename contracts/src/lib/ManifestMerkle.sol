// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ManifestMerkle — sorted-leaf merkle commitment over consumed-IOU-id manifests
/// @notice On-chain half of a dual TS↔Solidity implementation of one written
///         merkle spec (docs/PROTOCOL.md, decisions D-01..D-05). The TS twin is
///         `src/merkle.ts`; byte-parity between the two is locked by the shared
///         fixture `test/fixtures/merkle.json`. ClearingHubV2 derives each
///         round's `manifestHash` via `rootOf` inside `executeRound` and checks
///         redemption eligibility via `verifyNonInclusion` inside `redeemIOU`.
/// @dev    Construction: leaves are strictly-ascending unique bytes32 IOU ids
///         (numeric bytes32 order == the SDK's lowercase-hex lexicographic
///         order). Leaf hash = keccak256(0x00 || id); node hash =
///         keccak256(0x01 || left || right) — ordered concatenation, never
///         sorted, because adjacent-leaf bracketing non-inclusion proofs (D-05)
///         require positional order to be provable. Levels pair 2j/2j+1 into
///         parent j; an odd level's lone last node PROMOTES upward unchanged
///         (D-03) — this is NOT RFC 6962's largest-power-of-two split and NOT
///         Bitcoin-style duplication (which creates ambiguous trees,
///         CVE-2012-2459 class); only RFC 6962's 0x00/0x01 prefix domain
///         separation is borrowed, for second-preimage resistance. The empty
///         manifest commits to the v1 sentinel keccak256("") (D-04). Tree shape
///         is uniquely determined by leaf count, so verification binds
///         (leaf, index, leafCount) to the committed root.
///         Verify functions return bool and never revert — callers convert
///         failures to their own custom errors; only rootOf reverts
///         (UnsortedLeaves), as defense in depth beyond signature binding.
library ManifestMerkle {
    /// @notice Root of the empty manifest: keccak256 of empty bytes — byte-equal
    ///         to viem's keccak256("0x"), the v1 sentinel (D-04).
    bytes32 internal constant EMPTY_ROOT = keccak256("");

    /// @notice Claim that `leaf` sits at `index` in a `leafCount`-leaf manifest.
    /// @dev    `siblings` are bottom-up; promotion levels consume no sibling, so
    ///         the sibling count is schedule-determined by (index, leafCount).
    struct InclusionProof {
        bytes32 leaf; // raw IOU id (pre-leaf-hash)
        uint256 index; // 0-based position in the sorted leaf list
        uint256 leafCount; // total leaves of that round's manifest
        bytes32[] siblings; // bottom-up; promotion levels consume no sibling
    }

    /// @notice Which bracketing shape a non-inclusion claim takes.
    /// @dev    Enum order (0,1,2) matches the TS union "belowFirst"/"aboveLast"/
    ///         "bracket" — ABI/fixture parity depends on this ordering.
    enum NonInclusionKind {
        BelowFirst,
        AboveLast,
        Bracket
    }

    /// @notice Claim that an id is absent from the manifest committed by a root.
    struct NonInclusionProof {
        NonInclusionKind kind;
        InclusionProof a; // BelowFirst: first leaf | AboveLast: last leaf | Bracket: lower neighbor
        InclusionProof b; // Bracket only: upper neighbor (ignored otherwise)
    }

    /// @notice ids[index] <= ids[index-1]: input is descending or duplicated.
    error UnsortedLeaves(uint256 index);

    /// @notice Merkle root over strictly-ascending unique bytes32 ids; the
    ///         empty list returns the v1 sentinel EMPTY_ROOT.
    /// @dev    Reverts UnsortedLeaves on any descending or duplicate pair —
    ///         defense in depth even though signatures bind the digest. Builds
    ///         levels bottom-up in place; the lone node of an odd level
    ///         promotes unchanged (D-03).
    function rootOf(bytes32[] memory ids) internal pure returns (bytes32) {
        uint256 n = ids.length;
        if (n == 0) return EMPTY_ROOT;

        // leaf-hash pass, validating strict ascent
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            if (i > 0 && ids[i] <= ids[i - 1]) revert UnsortedLeaves(i);
            level[i] = keccak256(abi.encodePacked(bytes1(0x00), ids[i]));
        }

        // level-wise pairing with promotion; width halves (ceil) each pass.
        // (Shifts are index arithmetic, not protocol-value division.)
        uint256 w = n;
        while (w > 1) {
            uint256 nw = (w + 1) >> 1;
            for (uint256 j; j < w >> 1; ++j) {
                level[j] = keccak256(abi.encodePacked(bytes1(0x01), level[2 * j], level[2 * j + 1]));
            }
            if (w & 1 == 1) level[nw - 1] = level[w - 1]; // promote lone node (D-03)
            w = nw;
        }
        return level[0];
    }

    /// @notice True iff `p` proves its leaf sits at p.index in the
    ///         p.leafCount-leaf manifest committed by `root`.
    /// @dev    Never reverts: out-of-range index, wrong sibling count, tampered
    ///         siblings, or a wrong root all return false. The walk consumes a
    ///         sibling exactly when the schedule (index parity vs level width)
    ///         demands one; all siblings must be consumed.
    function verifyInclusion(InclusionProof memory p, bytes32 root) internal pure returns (bool) {
        if (p.index >= p.leafCount) return false;
        bytes32 h = keccak256(abi.encodePacked(bytes1(0x00), p.leaf));
        uint256 i = p.index;
        uint256 w = p.leafCount;
        uint256 s; // siblings consumed
        while (w > 1) {
            if (i & 1 == 1) {
                if (s == p.siblings.length) return false; // schedule demands a sibling
                h = keccak256(abi.encodePacked(bytes1(0x01), p.siblings[s], h));
                ++s;
            } else if (i != w - 1) {
                if (s == p.siblings.length) return false;
                h = keccak256(abi.encodePacked(bytes1(0x01), h, p.siblings[s]));
                ++s;
            }
            // else: lone node promotes unchanged (D-03)
            i >>= 1;
            w = (w + 1) >> 1;
        }
        return s == p.siblings.length && h == root;
    }

    /// @notice True iff `p` proves `id` is absent from the manifest committed
    ///         by `root`, via adjacent-leaf bracketing (D-05).
    /// @dev    Never reverts. Sentinel short-circuit: the empty manifest
    ///         contains nothing, so any id is absent. Strict inequalities
    ///         everywhere — an id equal to any proven leaf can never pass any
    ///         branch. Bracket additionally requires both neighbors to claim
    ///         the same manifest size and adjacent indices, so skipping a leaf
    ///         between them is structurally impossible.
    function verifyNonInclusion(bytes32 id, NonInclusionProof memory p, bytes32 root)
        internal
        pure
        returns (bool)
    {
        if (root == EMPTY_ROOT) return true;
        if (p.kind == NonInclusionKind.BelowFirst) {
            return verifyInclusion(p.a, root) && p.a.index == 0 && id < p.a.leaf;
        }
        if (p.kind == NonInclusionKind.AboveLast) {
            return verifyInclusion(p.a, root) && p.a.index == p.a.leafCount - 1 && id > p.a.leaf;
        }
        // Bracket
        return verifyInclusion(p.a, root) && verifyInclusion(p.b, root)
            && p.a.leafCount == p.b.leafCount && p.b.index == p.a.index + 1 && p.a.leaf < id
            && id < p.b.leaf;
    }
}
