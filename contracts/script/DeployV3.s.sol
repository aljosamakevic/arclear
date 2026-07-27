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
/// Optional staleness param (default used when unset):
///   HUB_K=3
///
/// V3 takes ONE tunable, not three. `HUB_RING` and `HUB_MAX_IOU_LIFETIME` are
/// gone with the root ring and the coverage rule they configured: redemption
/// now reads a permanent consumption ledger, so there is no buffer depth and no
/// IOU-lifetime bound left to calibrate. Passing either variable has no effect.
///
/// WR-10: `HUB_K` is range-checked BEFORE the uint64 downcast. DeployV2.s.sol
/// cast silently, so `HUB_K=2**64+3` deployed K=3 while echoing the operator's
/// number back at them, and the contract's own BadConfig guard only catches the
/// exact-multiple-of-2^64 case.
contract DeployV3 is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        require(token != address(0), "TOKEN_ADDRESS is the zero address");

        // The K default is UNCALIBRATED — staleness-vs-cadence calibration is
        // deferred to Phase 3 (D-08); this is a demo-scale placeholder, labeled
        // as such on the immutable's NatSpec too.
        uint256 kRaw = vm.envOr("HUB_K", uint256(3));
        require(kRaw > 0 && kRaw <= type(uint64).max, "HUB_K out of range");
        uint64 k = uint64(kRaw);

        vm.startBroadcast();
        ClearingHubV3 hub = new ClearingHubV3(IERC20(token), k);
        vm.stopBroadcast();

        console.log("ClearingHubV3 deployed for token %s at %s", token, address(hub));
        console.log("  K (staleness) = %s [UNCALIBRATED]", k);
        console.log("  owner = %s -- transfer to a multisig/timelock (WR-05)", hub.owner());
    }
}
