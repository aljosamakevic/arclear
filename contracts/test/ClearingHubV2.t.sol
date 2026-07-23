// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {RoundBuilderV2} from "./utils/RoundBuilderV2.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";
import {ManifestMerkle} from "../src/lib/ManifestMerkle.sol";

contract ClearingHubV2Test is RoundBuilderV2 {
    function setUp() public {
        _setUpActors();
    }

    /// Fund the debtor (actors[0]), sign an L-convention IOU to actors[1],
    /// then stale the debtor on the ON-CHAIN clock: K executed rounds without
    /// them (Pitfall 4 — never coordinator counters).
    function _staleSetup()
        internal
        returns (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id)
    {
        _fundAndDeposit(actors[0], 10e6);
        iou = _makeIou(actors[0], actors[1], 5e6, 1);
        sig = _signIou(keys[0], iou);
        id = hub.hashIou(iou);
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }
    }

    // ------------------------------------------------- executeRound evolution

    function test_executeRound_writesRootRing() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d, bytes32[] memory ids) = _simpleRound();
        _execute(p, d, ids);

        (bytes32 root, uint64 nonce_, uint64 executedAt) = hub.rootRing(0);
        assertEq(root, ManifestMerkle.rootOf(ids), "ring root != derived root");
        assertEq(nonce_, 0, "ring nonce");
        assertEq(executedAt, uint64(block.timestamp), "ring executedAt");
    }

    function test_executeRound_writesLastRoundForAllParticipants() public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](3);
        int256[] memory d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-1e6), int256(0), int256(1e6));
        _execute(p, d, _manifest(2, "lastround"));

        // 1-based marker nonce+1 for EVERY participant, zero-delta included:
        // their netted paper was consumed, participation is consent.
        assertEq(hub.lastRound(actors[0]), 1, "debtor lastRound");
        assertEq(hub.lastRound(actors[1]), 1, "zero-delta consenter lastRound");
        assertEq(hub.lastRound(actors[2]), 1, "creditor lastRound");
        assertEq(hub.lastRound(actors[3]), 0, "non-participant untouched");
    }

    function test_revert_executeRound_unsortedConsumedIds() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        bytes32[] memory ids = new bytes32[](2);
        (ids[0], ids[1]) = (bytes32(uint256(2)), bytes32(uint256(1))); // descending
        // rootOf reverts before any signature work — garbage sigs suffice.
        vm.expectRevert(abi.encodeWithSelector(ManifestMerkle.UnsortedLeaves.selector, 1));
        hub.executeRound(0, p, d, ids, new bytes[](2));
    }

    /// Exclusivity, redeem->cannot-net direction (D-14): a redeemed id in a
    /// later round's manifest reverts executeRound before signature checks.
    function test_revert_executeRound_nullifiedId() public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        hub.redeemIOU(iou, sig, _proofsFor(id));

        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        uint64 nonce_ = hub.roundNonce();
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.NullifiedIdInManifest.selector, id));
        hub.executeRound(nonce_, p, d, ids, new bytes[](2));
    }

    // ------------------------------------------------- redeemIOU happy path

    function test_redeemIOU_debitsStaleDebtor() public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        uint256 hubBalanceBefore = usdc.balanceOf(address(hub));

        vm.expectEmit(true, true, true, true);
        emit ClearingHubV2.IouRedeemed(id, actors[0], actors[1], 5e6, 3);
        hub.redeemIOU(iou, sig, _proofsFor(id));

        assertEq(hub.collateral(actors[0]), 5e6, "debtor debited exactly amount");
        assertEq(hub.collateral(actors[1]), 5e6, "creditor credited exactly amount");
        // Collateral conservation: redemption moves collateral, never tokens.
        assertEq(usdc.balanceOf(address(hub)), hubBalanceBefore, "hub balance not conserved");
        assertTrue(hub.redeemed(id), "nullifier set");
    }

    // --------------------------------------------------------- revert matrix

    function test_revert_redeemIOU_notStale() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        // Debtor participates in round 0, then misses only 2 of the 3 required.
        _executeRoundWithout(address(0)); // all five actors
        _executeRoundWithout(actors[0]);
        _executeRoundWithout(actors[0]);
        // roundNonce=3, lastRound[debtor]=1: 3 - 1 == 2 < K
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(hub.hashIou(iou));
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.DebtorNotStale.selector, 1, 3));
        hub.redeemIOU(iou, sig, proofs);
    }

    /// Never-participated debtor (lastRound == 0): stale iff roundNonce >= K.
    /// Both sides of the boundary (Pitfall 6).
    function test_revert_redeemIOU_neverParticipatedBoundary() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        bytes32 id = hub.hashIou(iou);

        _executeRoundWithout(actors[0]);
        _executeRoundWithout(actors[0]);
        // roundNonce == K-1 == 2: not yet stale
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.DebtorNotStale.selector, 0, 3));
        hub.redeemIOU(iou, sig, proofs);

        _executeRoundWithout(actors[0]);
        // roundNonce == K == 3: ignored every round that ever existed — stale
        hub.redeemIOU(iou, sig, _proofsFor(id));
        assertEq(hub.collateral(actors[0]), 5e6);
        assertEq(hub.collateral(actors[1]), 5e6);
    }

    /// Eviction occurred (roundNonce > RING) and the oldest buffered root does
    /// NOT predate expiry - L: a consuming round may be unverifiable — revert.
    function test_revert_redeemIOU_coverageNotBuffered() public {
        _fundAndDeposit(actors[0], 10e6);
        // Signed at t=1 with the L-convention max: expiry = 1 + L.
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 i; i < 17; ++i) {
            _executeRoundWithout(actors[0]); // RING+1 rounds: round 0 evicted
        }
        // oldest buffered round (nonce 1) executedAt=1 >= windowStart=1
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(hub.hashIou(iou));
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV2.CoverageWindowNotBuffered.selector, uint64(1), uint64(1)
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    /// expiry <= L with evicted history: the would-be underflow branch is
    /// fail-closed and reports windowStart 0 (the honest floor).
    function test_revert_redeemIOU_coverageExpiryUnderflow() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1, 100); // expiry <= L
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 i; i < 17; ++i) {
            _executeRoundWithout(actors[0]);
        }
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(hub.hashIou(iou));
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV2.CoverageWindowNotBuffered.selector, uint64(1), uint64(0)
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    /// Positive coverage after eviction: the oldest buffered root predates
    /// expiry - L, so every possible consuming round is still buffered.
    function test_redeemIOU_afterEviction_coverageWindowClear() public {
        _fundAndDeposit(actors[0], 10e6);
        for (uint256 i; i < 17; ++i) {
            _executeRoundWithout(actors[0]); // all executed at t=1
        }
        vm.warp(200000);
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1); // expiry = 200000 + L
        bytes memory sig = _signIou(keys[0], iou);
        hub.redeemIOU(iou, sig, _proofsFor(hub.hashIou(iou)));
        assertEq(hub.collateral(actors[1]), 5e6);
    }

    function test_revert_redeemIOU_badSignature() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[2], iou); // signer is not the debtor
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(hub.hashIou(iou));
        vm.expectRevert(ClearingHubV2.BadIouSignature.selector);
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_revert_redeemIOU_alreadyRedeemed() public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        hub.redeemIOU(iou, sig, _proofsFor(id));
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.AlreadyRedeemed.selector, id));
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_revert_redeemIOU_proofCountMismatch() public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        ManifestMerkle.NonInclusionProof[] memory full = _proofsFor(id);
        assertEq(full.length, 3, "test-internal: expected 3 buffered rounds");
        ManifestMerkle.NonInclusionProof[] memory short_ =
            new ManifestMerkle.NonInclusionProof[](2);
        (short_[0], short_[1]) = (full[0], full[1]); // drop one proof
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.ProofCountMismatch.selector, 3, 2));
        hub.redeemIOU(iou, sig, short_);
    }

    /// Exclusivity, structural net->cannot-redeem direction (MERK-04/D-15): an
    /// id consumed in a buffered round can never yield a valid non-inclusion
    /// proof for that round — strict inequalities make it impossible.
    function test_revert_redeemIOU_nonInclusionInvalid() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        bytes32 id = hub.hashIou(iou);

        _executeRoundWithout(actors[0]); // round 0: empty manifest
        // round 1 consumes the IOU id (with neighbors, so proofs are real)
        bytes32[] memory others = _manifest(2, "neighbors");
        bytes32[] memory ids = new bytes32[](3);
        (ids[0], ids[1], ids[2]) = (others[0], others[1], id);
        _sort(ids);
        _executeRoundWithout(actors[0], ids);
        _executeRoundWithout(actors[0]); // round 2 — debtor now stale

        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV2.NonInclusionProofInvalid.selector, uint64(1))
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    /// Withdraw-race honesty (Pitfall 2): redemption recovers posted,
    /// still-present collateral only — a debtor who exits first leaves nothing.
    function test_revert_redeemIOU_insufficientCollateral() public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        vm.prank(actors[0]);
        hub.withdraw(10e6); // never-pausable exit front-runs redemption
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV2.InsufficientCollateral.selector, actors[0], 0, 5e6
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_revert_redeemIOU_zeroAmount() public {
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 0, 1);
        vm.expectRevert(ClearingHubV2.ZeroAmount.selector);
        hub.redeemIOU(iou, "", new ManifestMerkle.NonInclusionProof[](0));
    }

    function test_revert_redeemIOU_selfIou() public {
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[0], 5e6, 1);
        vm.expectRevert(ClearingHubV2.SelfIou.selector);
        hub.redeemIOU(iou, "", new ManifestMerkle.NonInclusionProof[](0));
    }

    // -------------------------------------------------------- pause boundary

    function test_redeemIOU_revertsWhilePaused() public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);
        hub.pause();
        vm.expectRevert();
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_withdraw_worksWhilePaused_V2() public {
        _fundAndDeposit(actors[0], 10e6);
        hub.pause();
        vm.prank(actors[0]);
        hub.withdraw(10e6); // exit must never be pausable (D-12)
        assertEq(usdc.balanceOf(actors[0]), 10e6);
    }

    // ------------------------------------------------------------------ fuzz

    /// Stale setup where every buffered round carries a distinct NON-EMPTY
    /// manifest, so no proof is a sentinel short-circuit and positional
    /// mismatches are always detectable.
    function _staleSetupWithManifests()
        internal
        returns (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id)
    {
        _fundAndDeposit(actors[0], 10e6);
        iou = _makeIou(actors[0], actors[1], 5e6, 1);
        sig = _signIou(keys[0], iou);
        id = hub.hashIou(iou);
        for (uint256 r; r < K; ++r) {
            _executeRoundWithout(actors[0], _manifest(3, keccak256(abi.encode("fuzz-round", r))));
        }
    }

    /// T-02-21: a fuzz-chosen proof removed (count mismatch) or two proofs
    /// swapped (positional mismatch) always reverts, state untouched.
    function testFuzz_redeemProofSetSkip_reverts(uint256 seed) public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetupWithManifests();
        ManifestMerkle.NonInclusionProof[] memory full = _proofsFor(id);
        uint256 debtorBefore = hub.collateral(actors[0]);
        uint256 creditorBefore = hub.collateral(actors[1]);

        if (seed % 2 == 0) {
            // remove one fuzz-chosen proof: contract demands exactly 3
            uint256 drop = (seed >> 8) % 3;
            ManifestMerkle.NonInclusionProof[] memory bad =
                new ManifestMerkle.NonInclusionProof[](2);
            uint256 j;
            for (uint256 i; i < 3; ++i) {
                if (i != drop) bad[j++] = full[i];
            }
            vm.expectRevert(
                abi.encodeWithSelector(ClearingHubV2.ProofCountMismatch.selector, 3, 2)
            );
            hub.redeemIOU(iou, sig, bad);
        } else {
            // swap two distinct positions: proofs are pinned to ascending
            // nonces, and distinct manifests mean distinct roots
            uint256 i_ = seed % 3;
            uint256 j_ = (i_ + 1 + ((seed >> 8) % 2)) % 3;
            (full[i_], full[j_]) = (full[j_], full[i_]);
            vm.expectRevert(); // NonInclusionProofInvalid at first mismatched nonce
            hub.redeemIOU(iou, sig, full);
        }

        assertEq(hub.roundNonce(), 3, "state must be untouched");
        assertEq(hub.collateral(actors[0]), debtorBefore, "debtor balance moved");
        assertEq(hub.collateral(actors[1]), creditorBefore, "creditor balance moved");
    }

    /// T-02-22: after one successful redemption, fuzz-perturbed re-attempts
    /// always revert AlreadyRedeemed (nullifier precedes proof checks) and
    /// balances never move again.
    function testFuzz_redeemNullifierIdempotent(uint256 seed) public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetupWithManifests();
        hub.redeemIOU(iou, sig, _proofsFor(id));
        uint256 debtorAfter = hub.collateral(actors[0]);
        uint256 creditorAfter = hub.collateral(actors[1]);

        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);
        uint256 mode = seed % 3;
        if (mode == 1) {
            proofs = new ManifestMerkle.NonInclusionProof[]((seed >> 8) % 3); // wrong count
        } else if (mode == 2) {
            proofs[(seed >> 8) % 3].a.leaf = bytes32(seed); // garbage contents
        } // mode 0: byte-identical replay

        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.AlreadyRedeemed.selector, id));
        hub.redeemIOU(iou, sig, proofs);

        assertEq(hub.collateral(actors[0]), debtorAfter, "debtor balance moved again");
        assertEq(hub.collateral(actors[1]), creditorAfter, "creditor balance moved again");
        assertTrue(hub.redeemed(id), "nullifier must stay set");
    }

    /// T-02-21: perturbing index / leafCount / one sibling of a fuzz-chosen
    /// proof in an otherwise-valid set always reverts at that proof's nonce.
    function testFuzz_redeemProofPerturbation_reverts(uint256 seed) public {
        (ClearingHubV2.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetupWithManifests();
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);
        uint256 debtorBefore = hub.collateral(actors[0]);
        uint256 creditorBefore = hub.collateral(actors[1]);

        uint256 k = seed % 3;
        uint256 mode = (seed >> 8) % 3;
        if (mode == 0) {
            proofs[k].a.index += 1; // breaks kind-position binding / adjacency
        } else if (mode == 1) {
            // 3 -> 8 leaves: the full-tree schedule demands 3 siblings, the
            // proof carries at most 2 — schedule mismatch, never verifies
            proofs[k].a.leafCount += 5;
        } else {
            uint256 sc = proofs[k].a.siblings.length;
            uint256 si = (seed >> 16) % sc;
            proofs[k].a.siblings[si] =
                proofs[k].a.siblings[si] ^ bytes32(uint256(1) << ((seed >> 24) % 256));
        }

        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV2.NonInclusionProofInvalid.selector, uint64(k))
        );
        hub.redeemIOU(iou, sig, proofs);

        assertEq(hub.roundNonce(), 3, "state must be untouched");
        assertEq(hub.collateral(actors[0]), debtorBefore, "debtor balance moved");
        assertEq(hub.collateral(actors[1]), creditorBefore, "creditor balance moved");
    }

    // ------------------------------------------------------------------- gas

    /// Worst-case (fresh-state, all-cold) executeRound with n=5 participants
    /// and an m-id manifest; measured via gasleft() deltas around the call.
    function _gasExecuteRound(uint256 m) internal returns (uint256 used) {
        address[] memory p = new address[](5);
        int256[] memory d = new int256[](5);
        for (uint256 i; i < 5; ++i) {
            p[i] = actors[i];
        }
        (d[0], d[1], d[2], d[3], d[4]) =
            (int256(-3e6), int256(1e6), int256(2e6), int256(-1e6), int256(1e6));
        _fundAndDeposit(actors[0], 10e6);
        _fundAndDeposit(actors[3], 10e6);
        bytes32[] memory ids = _manifest(m, "gas-manifest");
        bytes[] memory sigs = _buildSignatures(0, p, d, ids);

        uint256 g0 = gasleft();
        hub.executeRound(0, p, d, ids, sigs);
        used = g0 - gasleft();
        assertEq(hub.roundNonce(), 1, "round must have executed");
    }

    function test_gas_executeRound_m10() public {
        console2.log("gas_executeRound n=5 m=10:", _gasExecuteRound(10));
    }

    function test_gas_executeRound_m105() public {
        console2.log("gas_executeRound n=5 m=105:", _gasExecuteRound(105));
    }

    function test_gas_executeRound_m250() public {
        console2.log("gas_executeRound n=5 m=250:", _gasExecuteRound(250));
    }

    /// redeemIOU with the full RING=16 populated: 16 real (non-sentinel)
    /// non-inclusion proofs over 8-id manifests.
    function test_gas_redeemIOU_ring16() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV2.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        bytes32 id = hub.hashIou(iou);
        for (uint256 r; r < 16; ++r) {
            _executeRoundWithout(actors[0], _manifest(8, keccak256(abi.encode("gas-ring", r))));
        }
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsFor(id);

        uint256 g0 = gasleft();
        hub.redeemIOU(iou, sig, proofs);
        uint256 used = g0 - gasleft();
        console2.log("gas_redeemIOU RING=16 (8-id manifests):", used);
        assertEq(hub.collateral(actors[1]), 5e6, "redemption must have settled");
    }
}
