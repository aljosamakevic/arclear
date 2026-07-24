// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PvPRouter} from "../src/PvPRouter.sol";

/// @dev D-05 obligation for the new PvPRound signed struct: the Solidity side
///      of the shared-fixture lock. Reads the same regenerated JSON vector as
///      the SDK's fixture-lock test (test/pvp.test.ts) and asserts that
///      PvPRouter.hashPvPRound reproduces viem's pvpDigest byte-for-byte and
///      that the fixture signer's viem consent recovers on-chain via OZ ECDSA.
///      Vectors come exclusively from the fixture — never hand-edited, never
///      hardcoded here (regeneration-only discipline, T-04-13).
contract PvPParityTest is Test {
    string internal json;
    PvPRouter internal router;

    function setUp() public {
        json = vm.readFile("../test/fixtures/digest.json");

        address routerAddr = vm.parseJsonAddress(json, ".pvpRouter");
        address hubUsdcAddr = vm.parseJsonAddress(json, ".pvpHubUsdc");
        address hubEurcAddr = vm.parseJsonAddress(json, ".pvpHubEurc");
        uint256 chainId = vm.parseJsonUint(json, ".chainId");

        // Recreate the fixture's exact domain: chain 5042002, router at the
        // fixture address. deployCodeTo runs the constructor so the hub-pair
        // immutables are set correctly (pattern proven by ClearingHubV2Parity's
        // K/RING constructor args). No hub code needs to exist at the fixture
        // hub addresses — the constructor only STORES them and hashPvPRound
        // never calls a hub.
        vm.chainId(chainId);
        deployCodeTo("PvPRouter.sol:PvPRouter", abi.encode(hubUsdcAddr, hubEurcAddr), routerAddr);
        router = PvPRouter(routerAddr);
    }

    /// @dev The two D-05 assertions, mirroring ClearingHubV2Parity: digest
    ///      equality across stacks, then signature recovery over that digest.
    function test_pvpDigestMatchesSdkFixture() public view {
        bytes32 usdcLegDigest = vm.parseJsonBytes32(json, ".pvpUsdcLegDigest");
        bytes32 eurcLegDigest = vm.parseJsonBytes32(json, ".pvpEurcLegDigest");
        uint256 fxNumerator = vm.parseJsonUint(json, ".pvpFxNumerator");
        uint256 fxDenominator = vm.parseJsonUint(json, ".pvpFxDenominator");
        bytes32 expectedDigest = vm.parseJsonBytes32(json, ".pvpDigest");
        address signer0 = vm.parseJsonAddress(json, ".pvpSigner0");
        bytes memory consent0 = vm.parseJsonBytes(json, ".pvpConsent0");

        bytes32 onchain =
            router.hashPvPRound(usdcLegDigest, eurcLegDigest, fxNumerator, fxDenominator);
        assertEq(onchain, expectedDigest, "TS and Solidity PvPRound digests diverge - D-05 violated");

        // viem PvP consent must recover on-chain: locks the whole signing path.
        assertEq(ECDSA.recover(onchain, consent0), signer0, "PvP consent signature recovery diverges");
    }
}
