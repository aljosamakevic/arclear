// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";

/// Deploys one ClearingHubV3 for TOKEN_ADDRESS. Explicit gas price is
/// mandatory on Arc (USDC is both native gas token and ERC-20):
///
///   TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
///   forge script script/DeployV3.s.sol --rpc-url arc_testnet \
///     --private-key $DEPLOYER_PK --broadcast --with-gas-price 25gwei
///
/// Optional redemption params (defaults used when unset):
///   HUB_K=3 HUB_RING=16 HUB_MAX_IOU_LIFETIME=86400
///
/// WR-10: every parameter is range-checked BEFORE the uint64 downcast.
/// DeployV2.s.sol cast silently, so `HUB_RING=2**64+16` deployed a hub with
/// RING=16 while echoing the operator's number back at them, and the contract's
/// own BadConfig guard only catches the exact-multiple-of-2^64 case. RING also
/// gets an upper bound: redeemIOU verifies one non-inclusion proof per buffered
/// round, so a RING in the thousands ships a hub whose redemption path can never
/// fit in a block.
contract DeployV3 is Script {
    /// @dev Beyond this, redeemIOU's proof loop stops fitting in a block.
    uint256 internal constant MAX_SAFE_RING = 64;

    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        require(token != address(0), "TOKEN_ADDRESS is the zero address");

        // K / RING / MAX_IOU_LIFETIME defaults are UNCALIBRATED — the
        // staleness-vs-ring-vs-cadence calibration is deferred to Phase 3
        // (D-08); these are demo-scale placeholders, labeled as such on the
        // immutables' NatSpec too.
        uint256 kRaw = vm.envOr("HUB_K", uint256(3));
        require(kRaw > 0 && kRaw <= type(uint64).max, "HUB_K out of range");
        uint256 ringRaw = vm.envOr("HUB_RING", uint256(16));
        require(ringRaw > 0 && ringRaw <= MAX_SAFE_RING, "HUB_RING out of gas-safe range");
        uint256 lifetimeRaw = vm.envOr("HUB_MAX_IOU_LIFETIME", uint256(86400));
        require(
            lifetimeRaw > 0 && lifetimeRaw <= type(uint64).max, "HUB_MAX_IOU_LIFETIME out of range"
        );

        uint64 k = uint64(kRaw);
        uint64 ring = uint64(ringRaw);
        uint64 maxIouLifetime = uint64(lifetimeRaw);

        vm.startBroadcast();
        ClearingHubV3 hub = new ClearingHubV3(IERC20(token), k, ring, maxIouLifetime);
        vm.stopBroadcast();

        console.log("ClearingHubV3 deployed for token %s at %s", token, address(hub));
        console.log("  K (staleness) = %s [UNCALIBRATED]", k);
        console.log("  RING (root buffer) = %s [UNCALIBRATED]", ring);
        console.log("  MAX_IOU_LIFETIME (L, seconds) = %s [UNCALIBRATED]", maxIouLifetime);
        console.log("  owner = %s -- transfer to a multisig/timelock (WR-05)", hub.owner());
    }
}
