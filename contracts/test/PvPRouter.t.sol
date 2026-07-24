// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PvPRoundBuilder} from "./utils/PvPRoundBuilder.sol";
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
}
