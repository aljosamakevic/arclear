// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {RoundBuilderV3} from "./utils/RoundBuilderV3.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";
import {ManifestMerkle} from "../src/lib/ManifestMerkle.sol";

/// @title  Audit PoCs re-run against ClearingHubV3
/// @notice Direct ports of the 2026-07-27 audit's CR-01 and CR-02 proofs-of-
///         concept (`.planning/audits/2026-07-27-full-audit/A-contracts.md`).
///         Against ClearingHubV2 every one of these attacks SUCCEEDED. Each
///         test below asserts the V3 outcome, and `test_poc1c` additionally
///         demonstrates the V2-vs-V3 divergence at the leaf level, so the
///         difference is machine-checked rather than argued.
///
///         `test_poc2b` is deliberately a PASSING demonstration that the CR-02
///         ring-flush primitive still exists at a raised price. It is honest
///         documentation of a known residual, not a regression: read the
///         contract-level NatSpec on ClearingHubV3 before treating CR-02 as
///         closed.
contract ClearingHubV3PoCTest is RoundBuilderV3 {
    // Victim pair, matching the audit's naming.
    address internal alice; // debtor
    address internal bob; // creditor
    // Unrelated attacker pair: zero collateral, never party to anything.
    address internal mallory;
    address internal trudy;

    function setUp() public {
        _setUpActors();
        alice = actors[0];
        bob = actors[1];
        mallory = actors[3];
        trudy = actors[4]; // actors is ascending, so mallory < trudy
    }

    /// @dev The attacker pair as a 2-participant round shape.
    function _attackerRound() internal view returns (address[] memory p, int256[] memory d) {
        p = new address[](2);
        (p[0], p[1]) = (mallory, trudy);
        d = new int256[](2);
    }

    /// @dev Alice deposits, signs an IOU to Bob, then goes stale (K rounds
    ///      without her). Mirrors the audit's steps 1-2.
    function _victimSetup()
        internal
        returns (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id)
    {
        _fundAndDeposit(alice, 10e6);
        iou = _makeIou(alice, bob, 5e6, 1);
        sig = _signIou(keys[0], iou);
        id = hub.hashIou(iou);
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(alice);
        }
    }

    // ---------------------------------------------------------------- CR-01

    /// Control: absent any attacker, Bob recovers 5 USDC.
    /// (Audit's `test_baseline_redeemSucceeds`.)
    function test_poc0_baseline_redeemSucceeds() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();
        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        assertEq(hub.collateral(bob), 5e6, "baseline redemption must work");
        assertEq(hub.collateral(alice), 5e6);
    }

    /// CR-01, by an unrelated third party.
    /// (Audit's `test_poc1_manifestPoisoningBlocksRedemption` — which PASSED
    /// against V2, permanently destroying the IOU's redeemability.)
    ///
    /// Mallory and Trudy hold zero collateral, are not party to the IOU, and
    /// have no signature from Alice or Bob over that id. They write Alice's IOU
    /// id into a round manifest — the best they can do is pair it with their OWN
    /// two addresses, because V3 requires both named parties to be signing
    /// participants of the round. That commits `leafId(id, mallory, trudy)`,
    /// which is not the leaf Bob proves against. The poisoning is inert.
    function test_poc1_manifestPoisoningNoLongerBlocksRedemption() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _victimSetup();

        (address[] memory p, int256[] memory d) = _attackerRound();
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = ClearingHubV3.ConsumedRef({id: id, partyAIdx: 0, partyBIdx: 1});
        _execute(p, d, refs); // the poisoning transaction, and it is accepted

        assertEq(hub.roundNonce(), 4, "poisoning round did execute");
        assertEq(hub.collateral(mallory), 0, "attacker really is capital-free");

        // ...and it achieved nothing.
        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        assertEq(hub.collateral(bob), 5e6, "poisoning must not block redemption");
        assertEq(hub.collateral(alice), 5e6, "debtor debited exactly amount");
    }

    /// CR-01, by the debtor against their own paper — the natural attacker.
    /// (Audit's `test_poc1b_debtorSelfPoisons`.) Alice knows the id of every
    /// IOU she ever signed. Under V2 one transaction listing them all made her
    /// permanently immune to `redeemIOU`. Under V3 she can only commit
    /// `leafId(id, alice, accomplice)`; committing the real `leafId(id, alice,
    /// bob)` would require Bob to be a participant and therefore to sign, and
    /// Bob will not sign away his own claim for nothing.
    function test_poc1b_debtorSelfPoisonIsInert() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _victimSetup();

        // Alice + an accomplice. Participants must be strictly ascending.
        address[] memory p = new address[](2);
        (p[0], p[1]) = alice < trudy ? (alice, trudy) : (trudy, alice);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = ClearingHubV3.ConsumedRef({id: id, partyAIdx: 0, partyBIdx: 1});
        _execute(p, new int256[](2), refs);

        // Alice's self-poisoning round refreshed her own liveness marker, so she
        // must go stale again before Bob can act — the ordinary K-round wait.
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(alice);
        }

        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        assertEq(hub.collateral(bob), 5e6, "self-poisoning must not defeat redemption");
    }

    /// The V2-vs-V3 divergence, at the leaf level, with no staging.
    ///
    /// Under V2 the manifest leaf WAS the raw id, so an attacker's manifest
    /// `[id]` produced a root that genuinely contains the victim's id: no
    /// non-inclusion proof for it can exist, by construction. Under V3 the
    /// attacker's manifest commits `leafId(id, mallory, trudy)` while the
    /// creditor proves `leafId(id, alice, bob)` — different leaves, so the
    /// honest non-inclusion proof still verifies.
    function test_poc1c_v2LeafSemanticsWouldStillFail() public view {
        bytes32 id = keccak256("victim-iou-id");

        // --- V2 semantics: leaf == raw id ---
        bytes32[] memory v2Leaves = new bytes32[](1);
        v2Leaves[0] = id;
        bytes32 v2Root = ManifestMerkle.rootOf(v2Leaves);
        // The best possible proof the harness can build for a leaf that IS
        // present is a well-formed one that verifies false.
        assertFalse(
            ManifestMerkle.verifyNonInclusion(id, _nonInclusion(v2Leaves, id), v2Root),
            "V2: a poisoned id can never be proven absent (this is CR-01)"
        );

        // --- V3 semantics: leaf == manifestLeafId(id, partyA, partyB) ---
        bytes32[] memory v3Leaves = new bytes32[](1);
        v3Leaves[0] = _leafId(id, mallory, trudy); // what the attacker can commit
        bytes32 v3Root = ManifestMerkle.rootOf(v3Leaves);
        bytes32 honestLeaf = _leafId(id, alice, bob); // what the creditor proves
        assertTrue(
            ManifestMerkle.verifyNonInclusion(
                honestLeaf, _nonInclusion(v3Leaves, honestLeaf), v3Root
            ),
            "V3: the honest leaf is still provably absent from a poisoned manifest"
        );
    }

    /// The flip side, so the fix is not mistaken for "redemption always wins":
    /// when the IOU is GENUINELY consumed — both parties participating and
    /// signing, which is now the only way — non-inclusion is impossible and
    /// redemption is correctly refused. Exclusivity survives the CR-01 fix.
    function test_poc1d_genuineConsumptionStillBlocksRedemption() public {
        _fundAndDeposit(alice, 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(alice, bob, 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        bytes32 id = hub.hashIou(iou);

        address[] memory p = new address[](2);
        (p[0], p[1]) = (alice, bob);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = _refFor(p, id, alice, bob);
        _execute(p, new int256[](2), refs); // an all-cancel round, both consenting

        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(alice);
        }

        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.NonInclusionProofInvalid.selector, uint64(0))
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    // ---------------------------------------------------------------- CR-02

    /// CR-02: the free round is gone.
    /// (Audit's `test_poc4_zeroCollateralRoundIsFree` / the enabler for
    /// `test_poc2_ringFlushPermanentlyBlocksRedemption`.)
    ///
    /// The exact shape the audit used — two zero-collateral addresses, zero
    /// deltas, empty manifest — is now rejected. Signatures are fully valid, so
    /// the revert is unambiguously the economic guard and not a consent failure.
    function test_poc2_freeRoundRejected() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();
        uint64 before = hub.roundNonce();

        (address[] memory p, int256[] memory d) = _attackerRound();
        bytes[] memory sigs = _buildSignatures(before, p, d, _noRefs());

        vm.warp(block.timestamp + 100);
        for (uint256 i; i < RING; ++i) {
            vm.expectRevert(ClearingHubV3.EmptyRound.selector);
            hub.executeRound(before, p, d, _noRefs(), sigs);
        }

        assertEq(hub.roundNonce(), before, "the ring must not have advanced at all");
        // The coverage window is untouched, so the victim's IOU stays redeemable.
        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        assertEq(hub.collateral(bob), 5e6, "redemption must survive the flush attempt");
    }

    /// KNOWN RESIDUAL — this test PASSES, and that is the point.
    ///
    /// `EmptyRound` prices the flush up; it does not remove it. An attacker who
    /// attaches one fabricated `ConsumedRef` over their own two addresses
    /// produces a round that is economically empty but formally non-empty, and
    /// RING of those still push `oldestExecutedAt` past the victim's window —
    /// permanently, because `oldestExecutedAt` is monotone while `windowStart`
    /// is fixed by the IOU's expiry.
    ///
    /// Closing this requires abandoning the nonce-indexed root ring and its
    /// non-inclusion regime in favour of an on-chain consumption ledger
    /// (`mapping(bytes32 => bool) consumed`), which makes redemption O(1) and
    /// the guarantee uncompressible at the cost of ~20k gas per consumed id on
    /// every round. That is a product-level gas decision, taken deliberately
    /// out of scope for this change.
    function test_poc2b_residual_minimalRoundsStillFlushTheRing() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();
        assertEq(hub.roundNonce(), 3, "audit's staging: 3 rounds, ring not yet full");

        vm.warp(block.timestamp + 100);
        (address[] memory p, int256[] memory d) = _attackerRound();

        uint256 spent;
        for (uint256 i; i < RING; ++i) {
            uint64 nonce_ = hub.roundNonce();
            ClearingHubV3.ConsumedRef[] memory refs =
                _manifest(p, 1, keccak256(abi.encode("flush", i)));
            bytes32[] memory leaves = _leaves(p, refs);
            bytes[] memory sigs = _buildSignatures(nonce_, p, d, leaves);
            uint256 g0 = gasleft();
            hub.executeRound(nonce_, p, d, refs, sigs);
            spent += g0 - gasleft();
            roundLeavesOf[nonce_] = leaves;
        }

        assertEq(hub.roundNonce(), 19, "ring flushed with formally-non-empty rounds");
        console2.log("CR-02 residual: gas to flush RING=16 slots:", spent);
        console2.log("  per round:", spent / RING);

        // Same terminal state the audit reported for V2: permanent denial.
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.CoverageWindowNotBuffered.selector, uint64(101), uint64(1)
            )
        );
        hub.redeemIOU(iou, sig, proofs);

        // ...and it stays permanent: waiting does not reopen the window.
        vm.warp(block.timestamp + 7 days);
        proofs = _proofsForIou(iou);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.CoverageWindowNotBuffered.selector, uint64(101), uint64(1)
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    /// WR-11 residual, measured rather than asserted-away: an already-stale
    /// debtor can still reset their own liveness clock, because a round they
    /// participate in refreshes `lastRound` regardless of whether any paper
    /// attributable to them was consumed. V3 raises the price from "free" to
    /// "one fabricated ref"; it does not remove the primitive. The audit's
    /// suggested fix — refresh `lastRound` only for participants who actually
    /// had a ref attributed to them — is now CHEAPLY AVAILABLE thanks to the
    /// CR-01 binding, and is left as a follow-up.
    function test_poc5_residual_staleDebtorStillResetsClock() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();

        address[] memory p = new address[](2);
        (p[0], p[1]) = alice < trudy ? (alice, trudy) : (trudy, alice);
        uint256 g0 = gasleft();
        _execute(p, new int256[](2), _manifest(p, 1, "keepalive"));
        console2.log("WR-11 residual: gas for one keep-alive round:", g0 - gasleft());

        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.DebtorNotStale.selector, 4, K));
        hub.redeemIOU(iou, sig, proofs);
    }
}
