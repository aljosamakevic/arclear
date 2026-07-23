// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";
import {MockUSDC} from "./utils/RoundBuilder.sol";

/// @dev Proves D-11 plus the Q5a digest-parity obligation: ClearingHubV2
///      reproduces the UNCHANGED v1 SDK fixture — same domain separator, same
///      ROUND_TYPEHASH, same hashRound encoding — and its first on-chain IOU
///      digest (`hashIou`) byte-matches the SDK's `iouId`, with the viem
///      debtor signature recovering on-chain. Reads the same regenerated JSON
///      vector as DigestParity.t.sol (no hand edits, regeneration only).
contract DigestParityV2Test is Test {
    string internal json;
    ClearingHubV2 internal hub;

    function setUp() public {
        json = vm.readFile("../test/fixtures/digest.json");

        address hubAddr = vm.parseJsonAddress(json, ".hub");
        uint256 chainId = vm.parseJsonUint(json, ".chainId");

        // Recreate the fixture's exact domain: chain 5042002, hub at the
        // fixture address (constructor runs elsewhere under deployCodeTo, so
        // OZ EIP712 falls back to computing the separator with live values).
        // Constructor now carries the uncalibrated K/RING/MAX_IOU_LIFETIME
        // defaults — none of them enter the EIP-712 domain, so digest parity
        // is insensitive to their values.
        vm.chainId(chainId);
        MockUSDC usdc = new MockUSDC();
        deployCodeTo(
            "ClearingHubV2.sol:ClearingHubV2",
            abi.encode(address(usdc), uint64(3), uint64(16), uint64(86400)),
            hubAddr
        );
        hub = ClearingHubV2(hubAddr);
    }

    function test_v2DigestMatchesV1SdkFixture() public view {
        uint64 nonce_ = uint64(vm.parseJsonUint(json, ".roundNonce"));
        address[] memory participants = vm.parseJsonAddressArray(json, ".participants");
        int256[] memory deltas = vm.parseJsonIntArray(json, ".deltas");
        bytes32 manifestHash = vm.parseJsonBytes32(json, ".manifestHash");
        bytes32 expectedDigest = vm.parseJsonBytes32(json, ".digest");
        address signer0 = vm.parseJsonAddress(json, ".signer0");
        bytes memory consent0 = vm.parseJsonBytes(json, ".consent0");

        bytes32 onchain = hub.hashRound(nonce_, participants, deltas, manifestHash);
        assertEq(onchain, expectedDigest, "V2 digest diverges from v1 fixture - D-11 violated");

        // viem signature must recover on-chain: locks the whole signing path.
        assertEq(ECDSA.recover(onchain, consent0), signer0, "consent signature recovery diverges");
    }

    /// @dev First on-chain implementation of the existing signed IOU struct:
    ///      hashIou must byte-match the SDK's iouId (viem hashTypedData) and
    ///      the fixture debtor's viem signature must recover on-chain.
    function test_hashIouMatchesSdkFixture() public view {
        address debtor = vm.parseJsonAddress(json, ".iouDebtor");
        ClearingHubV2.Iou memory iou = ClearingHubV2.Iou({
            debtor: debtor,
            creditor: vm.parseJsonAddress(json, ".iouCreditor"),
            amount: vm.parseJsonUint(json, ".iouAmount"),
            nonce: vm.parseJsonUint(json, ".iouNonce"),
            expiry: uint64(vm.parseJsonUint(json, ".iouExpiry")),
            ref: vm.parseJsonBytes32(json, ".iouRef")
        });
        bytes32 expectedId = vm.parseJsonBytes32(json, ".iouId");
        bytes memory iouSig = vm.parseJsonBytes(json, ".iouSig");

        bytes32 onchainId = hub.hashIou(iou);
        assertEq(onchainId, expectedId, "TS and Solidity IOU digests diverge");
        assertEq(ECDSA.recover(onchainId, iouSig), debtor, "IOU signature recovery diverges");
    }
}
