// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {PvPRoundBuilder} from "./utils/PvPRoundBuilder.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";
import {PvPRouter} from "../src/PvPRouter.sol";

/// @dev PvP router suite over the dual-hub PvPRoundBuilder harness: smoke
///      checks (constructor binding, digest sensitivity, zero-rate gate) plus
///      the positive both-legs-settle path across all three participant-set
///      regimes (overlapping, disjoint, identical — RESEARCH Q5). The full
///      revert matrix, the single-leg limitation test, and gas measurement
///      extend this contract in plan 04-04 tasks 2-3.
contract PvPRouterTest is PvPRoundBuilder {
    function setUp() public {
        _setUpPvP();
    }

    // ---------------------------------------------------------- constructor

    function test_constructor_immutables() public view {
        assertEq(address(router.hubUSDC()), address(hubUSDC), "hubUSDC binding");
        assertEq(address(router.hubEURC()), address(hubEURC), "hubEURC binding");
    }

    // --------------------------------------------------------- hashPvPRound

    function test_hashPvPRound_fieldSensitivity() public view {
        bytes32 dU = keccak256("usdc-leg-digest");
        bytes32 dE = keccak256("eurc-leg-digest");
        uint256 num = 989_589;
        uint256 den = 1_000_000;

        bytes32 baseline = router.hashPvPRound(dU, dE, num, den);

        // Determinism: same inputs, same digest.
        assertEq(router.hashPvPRound(dU, dE, num, den), baseline, "deterministic");

        // Every one of the 4 fields must move the digest.
        assertNotEq(
            router.hashPvPRound(keccak256("other"), dE, num, den), baseline, "usdcLegDigest inert"
        );
        assertNotEq(
            router.hashPvPRound(dU, keccak256("other"), num, den), baseline, "eurcLegDigest inert"
        );
        assertNotEq(router.hashPvPRound(dU, dE, num + 1, den), baseline, "fxNumerator inert");
        assertNotEq(router.hashPvPRound(dU, dE, num, den + 1), baseline, "fxDenominator inert");
    }

    // ------------------------------------------------- executePvP: ZeroRate

    function test_revert_executePvP_zeroNumerator() public {
        // Empty legs are fine — the rate gate fires before any leg data is touched.
        PvPRouter.Leg memory empty;
        vm.expectRevert(abi.encodeWithSelector(PvPRouter.ZeroRate.selector));
        router.executePvP(empty, empty, bytes32(0), bytes32(0), 0, 1_000_000, new bytes[](0));
    }

    function test_revert_executePvP_zeroDenominator() public {
        PvPRouter.Leg memory empty;
        vm.expectRevert(abi.encodeWithSelector(PvPRouter.ZeroRate.selector));
        router.executePvP(empty, empty, bytes32(0), bytes32(0), 989_589, 0, new bytes[](0));
    }

    // -------------------------------------------- executePvP: positive path

    /// Full both-or-neither positive: BOTH hub nonces advance, every
    /// collateral delta on BOTH hubs matches the signed leg exactly, and
    /// PvPExecuted fires with the recomputed digests + rate.
    function test_executePvP_bothLegsSettle() public {
        PvPBundle memory b = _simplePvP("both-legs");

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256[] memory cU = new uint256[](3);
        uint256[] memory cE = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            cU[i] = hubUSDC.collateral(b.usdcLeg.participants[i]);
            cE[i] = hubEURC.collateral(b.eurcLeg.participants[i]);
        }
        bytes32 pvpDigest =
            router.hashPvPRound(b.usdcDigest, b.eurcDigest, b.fxNumerator, b.fxDenominator);

        vm.expectEmit(true, true, true, true, address(router));
        emit PvPRouter.PvPExecuted(
            b.usdcDigest, b.eurcDigest, b.fxNumerator, b.fxDenominator, pvpDigest
        );
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU + 1, "USDC nonce must advance");
        assertEq(hubEURC.roundNonce(), nE + 1, "EURC nonce must advance");
        for (uint256 i; i < 3; ++i) {
            assertEq(
                hubUSDC.collateral(b.usdcLeg.participants[i]),
                uint256(int256(cU[i]) + b.usdcLeg.deltas[i]),
                "USDC collateral delta"
            );
            assertEq(
                hubEURC.collateral(b.eurcLeg.participants[i]),
                uint256(int256(cE[i]) + b.eurcLeg.deltas[i]),
                "EURC collateral delta"
            );
        }
    }

    /// Disjoint participant sets: union = concatenation (RESEARCH Q5 — a
    /// signer in one leg only still attests the bundle + rate).
    function test_executePvP_disjointSets() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 5e6);
        _fundAndDeposit(hubEURC, eurc, actors[2], 5e6);

        address[] memory pU = new address[](2);
        (pU[0], pU[1]) = (actors[0], actors[1]);
        int256[] memory dU = new int256[](2);
        (dU[0], dU[1]) = (int256(-1e6), int256(1e6));

        address[] memory pE = new address[](2);
        (pE[0], pE[1]) = (actors[2], actors[3]);
        int256[] memory dE = new int256[](2);
        (dE[0], dE[1]) = (int256(-1e6), int256(1e6));

        PvPBundle memory b = _bundle(
            hubUSDC.roundNonce(),
            pU,
            dU,
            _manifest(2, "disjoint-usdc"),
            hubEURC.roundNonce(),
            pE,
            dE,
            _manifest(2, "disjoint-eurc"),
            989_589,
            1_000_000
        );
        assertEq(b.pvpSignatures.length, 4, "union must be the 4-member concatenation");

        _submit(b);

        assertEq(hubUSDC.roundNonce(), 1, "USDC nonce must advance");
        assertEq(hubEURC.roundNonce(), 1, "EURC nonce must advance");
        assertEq(hubUSDC.collateral(actors[0]), 4e6, "USDC debtor debited");
        assertEq(hubUSDC.collateral(actors[1]), 1e6, "USDC creditor credited");
        assertEq(hubEURC.collateral(actors[2]), 4e6, "EURC debtor debited");
        assertEq(hubEURC.collateral(actors[3]), 1e6, "EURC creditor credited");
    }

    /// Identical participant sets: union == either set, one signature each.
    function test_executePvP_identicalSets() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 5e6);
        _fundAndDeposit(hubEURC, eurc, actors[2], 5e6);

        address[] memory p = new address[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-2e6), int256(1e6), int256(1e6));
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(1e6), int256(1e6), int256(-2e6));

        PvPBundle memory b = _bundle(
            hubUSDC.roundNonce(),
            p,
            dU,
            _manifest(2, "identical-usdc"),
            hubEURC.roundNonce(),
            p,
            dE,
            _manifest(2, "identical-eurc"),
            989_589,
            1_000_000
        );
        assertEq(b.pvpSignatures.length, 3, "union must collapse to the 3-member set");

        _submit(b);

        assertEq(hubUSDC.roundNonce(), 1, "USDC nonce must advance");
        assertEq(hubEURC.roundNonce(), 1, "EURC nonce must advance");
        assertEq(hubUSDC.collateral(actors[0]), 3e6, "USDC debtor debited");
        assertEq(hubUSDC.collateral(actors[1]), 1e6, "USDC creditor credited");
        assertEq(hubUSDC.collateral(actors[2]), 1e6, "USDC creditor credited (2)");
        assertEq(hubEURC.collateral(actors[0]), 1e6, "EURC creditor credited");
        assertEq(hubEURC.collateral(actors[1]), 1e6, "EURC creditor credited (2)");
        assertEq(hubEURC.collateral(actors[2]), 3e6, "EURC debtor debited");
    }

    // ------------------------------------------- executePvP: revert matrix
    // Every test asserts the both-or-neither postcondition after the revert:
    // both roundNonces unchanged plus representative collateral reads on
    // BOTH hubs (the USDC debtor/creditor and the EURC debtor/creditor).

    /// THE atomicity proof (Pitfall 1): the EURC leg fails signature checks
    /// AFTER the USDC leg already executed inside the same call — revert
    /// bubbling must undo the USDC leg's nonce advance and collateral moves.
    function test_revert_executePvP_badLegSignature() public {
        PvPBundle memory b = _simplePvP("bad-leg-sig");
        // Valid-format signature by a non-participant over the right digest:
        // ECDSA recovers cleanly to the wrong address -> BadSignature(0).
        b.eurcLeg.signatures[0] = _signRound(
            _keyOf(actors[4]),
            hubEURC,
            b.eurcLeg.nonce,
            b.eurcLeg.participants,
            b.eurcLeg.deltas,
            b.eurcLeg.consumedIds
        );

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.BadSignature.selector, 0));
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// A leg validly signed over a FUTURE nonce passes digest binding and
    /// union consent, then its hub reverts WrongRoundNonce — bubbling takes
    /// the already-executed USDC leg with it.
    function test_revert_executePvP_wrongLegNonce() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 10e6);
        _fundAndDeposit(hubEURC, eurc, actors[1], 10e6);

        address[] memory pU = new address[](3);
        (pU[0], pU[1], pU[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        address[] memory pE = new address[](3);
        (pE[0], pE[1], pE[2]) = (actors[1], actors[2], actors[3]);
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(-3e6), int256(1e6), int256(2e6));

        // EURC leg signed over nonce current+1: stale-by-construction.
        PvPBundle memory b = _bundle(
            hubUSDC.roundNonce(),
            pU,
            dU,
            _manifest(3, "wrong-nonce-usdc"),
            hubEURC.roundNonce() + 1,
            pE,
            dE,
            _manifest(3, "wrong-nonce-eurc"),
            989_589,
            1_000_000
        );

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV2.WrongRoundNonce.selector, nE, nE + 1)
        );
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// Consented deltas stay valid signatures after a withdrawal — the EURC
    /// debtor drains their collateral post-consent, so the second leg fails
    /// the collateral check and the settled first leg must fully revert.
    function test_revert_executePvP_insufficientCollateralSecondLeg() public {
        PvPBundle memory b = _simplePvP("drained-eurc");
        vm.prank(actors[1]);
        hubEURC.withdraw(10e6); // drain the EURC debtor on the EURC hub only

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV2.InsufficientCollateral.selector, actors[1], 0, 3e6
            )
        );
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// A paused EURC hub rejects executeRound (RESEARCH Q1.4) — EnforcedPause
    /// bubbles through the router and reverts the executed USDC leg.
    function test_revert_executePvP_pausedHub() public {
        PvPBundle memory b = _simplePvP("paused-eurc");
        hubEURC.pause(); // harness is the owner

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// A tampered union signature (valid format, wrong recovered address at
    /// index 1) is rejected before either hub is called.
    function test_revert_executePvP_badPvPSignature() public {
        PvPBundle memory b = _simplePvP("bad-pvp-sig");
        bytes32 pvpDigest =
            router.hashPvPRound(b.usdcDigest, b.eurcDigest, b.fxNumerator, b.fxDenominator);
        b.pvpSignatures[1] = _signPvP(_keyOf(actors[4]), pvpDigest); // not union_[1]

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(abi.encodeWithSelector(PvPRouter.BadPvPSignature.selector, 1));
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// Dropping one union signature trips the exact-count rule: every union
    /// member must consent, no exceptions.
    function test_revert_executePvP_pvpSignatureCountMismatch() public {
        PvPBundle memory b = _simplePvP("dropped-sig");
        bytes[] memory short_ = new bytes[](b.pvpSignatures.length - 1);
        for (uint256 i; i < short_.length; ++i) {
            short_[i] = b.pvpSignatures[i];
        }
        b.pvpSignatures = short_; // union of {A,B,C} u {B,C,D} = 4, provided 3

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(
            abi.encodeWithSelector(PvPRouter.PvPSignatureCountMismatch.selector, 4, 3)
        );
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// Disordered participants in one leg break the merged stream's strict
    /// ascent — rejected router-locally, before any hub call. The leg digest
    /// is recomputed over the swapped array so binding passes and the union
    /// merge is the check that fires.
    function test_revert_executePvP_unionDisorder() public {
        PvPBundle memory b = _simplePvP("union-disorder");
        (b.usdcLeg.participants[0], b.usdcLeg.participants[1]) =
            (b.usdcLeg.participants[1], b.usdcLeg.participants[0]);
        b.usdcDigest = _digestV2(
            hubUSDC,
            b.usdcLeg.nonce,
            b.usdcLeg.participants,
            b.usdcLeg.deltas,
            b.usdcLeg.consumedIds
        );

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(abi.encodeWithSelector(PvPRouter.UnionNotStrictlyAscending.selector));
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// A signed digest that does not match the recomputed calldata digest is
    /// rejected per leg, before any execution (Pitfall 2).
    function test_revert_executePvP_legDigestMismatch() public {
        PvPBundle memory b = _simplePvP("digest-mismatch");

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        bytes32 goodU = b.usdcDigest;
        b.usdcDigest = keccak256("wrong-usdc-digest");
        vm.expectRevert(abi.encodeWithSelector(PvPRouter.LegDigestMismatch.selector, 0));
        _submit(b);

        b.usdcDigest = goodU;
        b.eurcDigest = keccak256("wrong-eurc-digest");
        vm.expectRevert(abi.encodeWithSelector(PvPRouter.LegDigestMismatch.selector, 1));
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// Structural replay protection (RESEARCH Q2): each signed leg digest
    /// binds its hub's roundNonce, so re-submitting the identical calldata
    /// reverts WrongRoundNonce with NO router state involved.
    function test_revert_executePvP_replaySameBundle() public {
        PvPBundle memory b = _simplePvP("replay");
        _submit(b); // first submission settles both legs

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);
        uint256 cE1 = hubEURC.collateral(actors[1]);
        uint256 cE3 = hubEURC.collateral(actors[3]);

        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.WrongRoundNonce.selector, nU, 0));
        _submit(b); // identical calldata

        assertEq(hubUSDC.roundNonce(), nU, "USDC nonce must not advance again");
        assertEq(hubEURC.roundNonce(), nE, "EURC nonce must not advance again");
        assertEq(hubUSDC.collateral(actors[0]), cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), cE3, "EURC creditor collateral moved");
    }

    /// MACHINE-DOCUMENTED LIMITATION (RESEARCH Q2c, accept-and-document;
    /// D-13 cites this test). Leg consents are ordinary, valid standalone hub
    /// Round signatures: an adversary who obtains one leg's complete
    /// signature set — including by extracting it from this router's pending
    /// transaction in the mempool — can settle that leg DIRECTLY on its hub,
    /// without its twin. PvP both-or-neither holds within the router path
    /// and against every failure/revert mode above; it does NOT hold against
    /// unilateral direct submission of one leg. The downgrade is bounded: the
    /// settled leg moved only unanimously signed balances, and the open leg's
    /// obligations remain ordinary collateral-backed credit (nettable later,
    /// recoverable via redeemIOU) — never unsigned movement. See
    /// docs/THREAT-MODEL.md (single-leg extraction) for the full analysis
    /// and the signature custody discipline that narrows the window.
    function test_singleLegDirectSubmissionSettles() public {
        PvPBundle memory b = _simplePvP("single-leg");

        uint64 nU = hubUSDC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU1 = hubUSDC.collateral(actors[1]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);

        // The USDC leg's calldata + signatures, submitted directly to the
        // hub, bypassing the router entirely: it SETTLES.
        hubUSDC.executeRound(
            b.usdcLeg.nonce,
            b.usdcLeg.participants,
            b.usdcLeg.deltas,
            b.usdcLeg.consumedIds,
            b.usdcLeg.signatures
        );

        assertEq(hubUSDC.roundNonce(), nU + 1, "single leg must settle: nonce advances");
        assertEq(
            hubUSDC.collateral(actors[0]),
            uint256(int256(cU0) + b.usdcLeg.deltas[0]),
            "single leg must settle: debtor debited"
        );
        assertEq(
            hubUSDC.collateral(actors[1]),
            uint256(int256(cU1) + b.usdcLeg.deltas[1]),
            "single leg must settle: creditor credited"
        );
        assertEq(
            hubUSDC.collateral(actors[2]),
            uint256(int256(cU2) + b.usdcLeg.deltas[2]),
            "single leg must settle: creditor credited (2)"
        );

        // The router bundle is now structurally dead: the USDC leg's signed
        // nonce is consumed, so the atomic path reverts WrongRoundNonce.
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.WrongRoundNonce.selector, nU + 1, nU));
        _submit(b);
    }
}
