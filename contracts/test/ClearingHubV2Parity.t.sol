// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";
import {MockUSDC} from "./utils/RoundBuilder.sol";

/// @dev Proves D-11: ClearingHubV2 reproduces the UNCHANGED v1 SDK fixture —
///      same domain separator, same typehash, same hashRound encoding. Reads
///      the same JSON vector as DigestParity.t.sol (no regeneration) and
///      asserts the V2 on-chain digest — and signature recovery — match viem's.
contract DigestParityV2Test is Test {
    function test_v2DigestMatchesV1SdkFixture() public {
        string memory json = vm.readFile("../test/fixtures/digest.json");

        address hubAddr = vm.parseJsonAddress(json, ".hub");
        uint256 chainId = vm.parseJsonUint(json, ".chainId");
        uint64 nonce_ = uint64(vm.parseJsonUint(json, ".roundNonce"));
        address[] memory participants = vm.parseJsonAddressArray(json, ".participants");
        int256[] memory deltas = vm.parseJsonIntArray(json, ".deltas");
        bytes32 manifestHash = vm.parseJsonBytes32(json, ".manifestHash");
        bytes32 expectedDigest = vm.parseJsonBytes32(json, ".digest");
        address signer0 = vm.parseJsonAddress(json, ".signer0");
        bytes memory consent0 = vm.parseJsonBytes(json, ".consent0");

        // Recreate the fixture's exact domain: chain 5042002, hub at the
        // fixture address (constructor runs elsewhere under deployCodeTo, so
        // OZ EIP712 falls back to computing the separator with live values).
        vm.chainId(chainId);
        MockUSDC usdc = new MockUSDC();
        deployCodeTo("ClearingHubV2.sol:ClearingHubV2", abi.encode(address(usdc)), hubAddr);
        ClearingHubV2 hub = ClearingHubV2(hubAddr);

        bytes32 onchain = hub.hashRound(nonce_, participants, deltas, manifestHash);
        assertEq(onchain, expectedDigest, "V2 digest diverges from v1 fixture - D-11 violated");

        // viem signature must recover on-chain: locks the whole signing path.
        assertEq(ECDSA.recover(onchain, consent0), signer0, "consent signature recovery diverges");
    }
}
