// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";

/// Deploys one ClearingHubV2 for TOKEN_ADDRESS. Explicit gas price is
/// mandatory on Arc (USDC is both native gas token and ERC-20):
///
///   TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
///   forge script script/DeployV2.s.sol --rpc-url arc_testnet \
///     --private-key $DEPLOYER_PK --broadcast --with-gas-price 25gwei
///
/// Optional redemption params (defaults used when unset):
///   HUB_K=3 HUB_RING=16 HUB_MAX_IOU_LIFETIME=86400
contract DeployV2 is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        // K / RING / MAX_IOU_LIFETIME defaults are UNCALIBRATED — the
        // staleness-vs-ring-vs-cadence calibration is deferred to Phase 3
        // (D-08); these are demo-scale placeholders, labeled as such on the
        // immutables' NatSpec too.
        uint64 k = uint64(vm.envOr("HUB_K", uint256(3)));
        uint64 ring = uint64(vm.envOr("HUB_RING", uint256(16)));
        uint64 maxIouLifetime = uint64(vm.envOr("HUB_MAX_IOU_LIFETIME", uint256(86400)));
        vm.startBroadcast();
        ClearingHubV2 hub = new ClearingHubV2(IERC20(token), k, ring, maxIouLifetime);
        vm.stopBroadcast();
        console.log("ClearingHubV2 deployed for token %s at %s", token, address(hub));
        console.log("  K (staleness) = %s [UNCALIBRATED]", k);
        console.log("  RING (root buffer) = %s [UNCALIBRATED]", ring);
        console.log("  MAX_IOU_LIFETIME (L, seconds) = %s [UNCALIBRATED]", maxIouLifetime);
    }
}
