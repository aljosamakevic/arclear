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
contract DeployV2 is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        vm.startBroadcast();
        ClearingHubV2 hub = new ClearingHubV2(IERC20(token));
        vm.stopBroadcast();
        console.log("ClearingHubV2 deployed for token %s at %s", token, address(hub));
    }
}
