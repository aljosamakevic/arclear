// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./utils/RoundBuilder.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";
import {PvPRouter} from "../src/PvPRouter.sol";

/// @dev Smoke tests for the PvP router: constructor hub binding, PvPRound
///      digest field sensitivity, and the zero-rate gate — the first checks
///      of the executePvP revert matrix. The full matrix (leg digest
///      mismatch, union verification, both-or-neither, single-leg direct
///      submission, gas) lands in plan 04-04, which extends this file and
///      migrates setUp into a shared PvPRoundBuilder harness — keep setUp
///      minimal and reusable.
contract PvPRouterTest is Test {
    // Deploy defaults matching DeployV2 / RoundBuilderV2 (UNCALIBRATED, D-08).
    uint64 internal constant K = 3;
    uint64 internal constant RING = 16;
    uint64 internal constant L = 86400;

    MockUSDC internal usdc;
    MockUSDC internal eurc;
    ClearingHubV2 internal hubUSDC;
    ClearingHubV2 internal hubEURC;
    PvPRouter internal router;

    function setUp() public {
        usdc = new MockUSDC();
        eurc = new MockUSDC(); // same mock shape; the hub only needs an ERC-20
        hubUSDC = new ClearingHubV2(usdc, K, RING, L);
        hubEURC = new ClearingHubV2(eurc, K, RING, L);
        router = new PvPRouter(hubUSDC, hubEURC);
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
}
