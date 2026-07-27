// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ManifestMerkle} from "../src/lib/ManifestMerkle.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";
import {PvPRouterV3} from "../src/PvPRouterV3.sol";
import {MockUSDC} from "./utils/RoundBuilder.sol";

/// @title  Cross-stack parity for the v3 PARTY-BOUND manifest leaf
/// @notice The v3 sibling of MerkleParity.t.sol. Where that file locks the
///         merkle CONSTRUCTION (which is unchanged), this one locks the LEAF
///         DERIVATION that v3 introduced — `manifestLeafId(id, lo, hi)` — and
///         the sort discipline that follows from it.
/// @dev    Three implementations of one function now exist and must stay
///         byte-identical: `src/merkle.ts` (which builds every manifest a
///         participant signs), `ClearingHubV3.manifestLeafId` (which decides
///         what `consumed` is keyed on, and therefore what `redeemIOU`
///         refuses), and `PvPRouterV3.manifestLeafId` (which reproduces leg
///         digests). A divergence between any two of them is not a cosmetic
///         bug: it either makes honest rounds unsignable (LegDigestMismatch /
///         BadSignature) or, worse, writes consumption-ledger entries under
///         keys no redemption ever reads, which is precisely the CR-01 failure
///         v3 exists to close. So all three are asserted here against the SAME
///         vectors the SDK generated (`npm run fixture` -> merkle.json), in
///         both a unit and a fuzz form.
///
///         Vectors come exclusively from the fixture — never hand-edited,
///         never hardcoded here (regeneration-only discipline, T-04-13).
contract MerkleParityV3Test is Test {
    string internal json;
    ClearingHubV3 internal hub;
    PvPRouterV3 internal router;

    function setUp() public {
        json = vm.readFile("../test/fixtures/merkle.json");
        MockUSDC usdc = new MockUSDC();
        hub = new ClearingHubV3(usdc, 3);
        // The router's constructor rejects a zero or identical hub pair
        // (WR-07), so give it two distinct hubs. It never calls either one for
        // manifestLeafId — the mirror is pure.
        router = new PvPRouterV3(hub, new ClearingHubV3(usdc, 3));
    }

    // ------------------------------------------------------------- leaf parity

    /// @dev The single-leaf vector, against BOTH on-chain implementations.
    function test_leafIdMatchesSdkFixture() public view {
        bytes32 id = vm.parseJsonBytes32(json, ".v3Leaf_id");
        address lo = vm.parseJsonAddress(json, ".v3Leaf_partyLo");
        address hi = vm.parseJsonAddress(json, ".v3Leaf_partyHi");
        bytes32 expected = vm.parseJsonBytes32(json, ".v3Leaf_expected");

        // Fixture self-check: the vector is only meaningful if the recorded
        // pair really is ordered, since that is what the canonicalization does.
        assertLt(uint160(lo), uint160(hi), "fixture partyLo is not below partyHi");

        assertEq(
            hub.manifestLeafId(id, lo, hi),
            expected,
            "TS and ClearingHubV3 manifest leaves diverge - CR-01 binding broken"
        );
        assertEq(
            router.manifestLeafId(id, lo, hi),
            expected,
            "PvPRouterV3's manifestLeafId mirror has drifted from the SDK"
        );
    }

    /// @dev Order-insensitivity: supplying the pair the other way round derives
    ///      the SAME leaf. This is what removes the role-swap footgun where a
    ///      coordinator transposing debtor and creditor would commit a leaf the
    ///      creditor's own redemption check never reads, leaving genuinely
    ///      netted paper redeemable.
    function test_leafIdIsOrderInsensitive() public view {
        bytes32 id = vm.parseJsonBytes32(json, ".v3Leaf_id");
        address lo = vm.parseJsonAddress(json, ".v3Leaf_partyLo");
        address hi = vm.parseJsonAddress(json, ".v3Leaf_partyHi");
        bytes32 expected = vm.parseJsonBytes32(json, ".v3Leaf_expected");

        assertEq(hub.manifestLeafId(id, hi, lo), expected, "hub leaf depends on argument order");
        assertEq(router.manifestLeafId(id, hi, lo), expected, "router leaf depends on argument order");
    }

    /// @dev The binding itself: pairing the same id with DIFFERENT addresses
    ///      must derive a different leaf. This is the whole of CR-01 — an
    ///      attacker who writes a victim's id into a manifest under their own
    ///      addresses lands on a key no honest redemption reads.
    function testFuzz_leafIdBindsTheParties(bytes32 id, address a, address b, address c) public view {
        vm.assume(a != b);
        vm.assume(c != a && c != b);
        bytes32 honest = hub.manifestLeafId(id, a, b);
        assertTrue(honest != hub.manifestLeafId(id, a, c), "leaf did not bind partyB");
        assertTrue(honest != hub.manifestLeafId(id, c, b), "leaf did not bind partyA");
    }

    /// @dev Full three-way parity across the whole input space, not just the
    ///      committed points.
    function testFuzz_leafIdParityAcrossImplementations(bytes32 id, address a, address b)
        public
        view
    {
        assertEq(hub.manifestLeafId(id, a, b), router.manifestLeafId(id, a, b), "hub/router divergence");
    }

    // --------------------------------------------------------- manifest parity

    /// @dev The multi-entry vector, in CONSUMED-REF ORDER. Deriving each leaf
    ///      from its own (id, partyA, partyB) and feeding the result straight
    ///      to `rootOf` is exactly what `executeRound` does, so this pins the
    ///      full pipeline: derivation, ascent, and root.
    function test_manifestRootFromRefsMatchesSdkFixture() public view {
        bytes32[] memory ids = vm.parseJsonBytes32Array(json, ".v3Manifest_ids");
        address[] memory partyA = vm.parseJsonAddressArray(json, ".v3Manifest_partyA");
        address[] memory partyB = vm.parseJsonAddressArray(json, ".v3Manifest_partyB");
        bytes32[] memory committedLeaves = vm.parseJsonBytes32Array(json, ".v3Manifest_leaves");
        bytes32 expectedRoot = vm.parseJsonBytes32(json, ".v3Manifest_root");

        assertEq(partyA.length, ids.length, "fixture arrays are not index-aligned");
        assertEq(partyB.length, ids.length, "fixture arrays are not index-aligned");
        assertEq(committedLeaves.length, ids.length, "fixture arrays are not index-aligned");

        bytes32[] memory leaves = new bytes32[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            leaves[i] = hub.manifestLeafId(ids[i], partyA[i], partyB[i]);
            assertEq(leaves[i], committedLeaves[i], "derived leaf diverges from the SDK's");
        }

        // rootOf reverts UnsortedLeaves unless the DERIVED leaves ascend, so a
        // pass here is also the assertion that the SDK sorted by leaf.
        assertEq(ManifestMerkle.rootOf(leaves), expectedRoot, "TS and Solidity manifest roots diverge");
    }

    /// @dev Negative half of the sort lock: the same refs ordered by RAW ID —
    ///      the v2 discipline — must be rejected. Without this the fixture
    ///      would only prove that SOME order works, not that leaf order is the
    ///      required one.
    function test_revert_manifestSortedByRawIdIsRejected() public {
        bytes32[] memory ids = vm.parseJsonBytes32Array(json, ".v3Manifest_ids");
        address[] memory partyA = vm.parseJsonAddressArray(json, ".v3Manifest_partyA");
        address[] memory partyB = vm.parseJsonAddressArray(json, ".v3Manifest_partyB");

        // Insertion-sort the refs by raw id, then derive leaves in that order.
        uint256 n = ids.length;
        for (uint256 i = 1; i < n; ++i) {
            for (uint256 j = i; j > 0 && ids[j - 1] > ids[j]; --j) {
                (ids[j - 1], ids[j]) = (ids[j], ids[j - 1]);
                (partyA[j - 1], partyA[j]) = (partyA[j], partyA[j - 1]);
                (partyB[j - 1], partyB[j]) = (partyB[j], partyB[j - 1]);
            }
        }
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            leaves[i] = hub.manifestLeafId(ids[i], partyA[i], partyB[i]);
        }

        // The fixture guarantees leaf order != id order, so this must revert.
        // Only the selector is asserted: WHICH index first breaks ascent is a
        // property of the fixture's addresses, not of the rule being pinned.
        vm.expectPartialRevert(ManifestMerkle.UnsortedLeaves.selector);
        this.rootOfExternal(leaves);
    }

    /// @dev `rootOf` is an internal library function; expectRevert needs an
    ///      external call boundary to observe the revert.
    function rootOfExternal(bytes32[] memory leaves) external pure returns (bytes32) {
        return ManifestMerkle.rootOf(leaves);
    }
}
