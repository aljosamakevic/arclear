// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ClearingHub} from "../src/ClearingHub.sol";

/// Deploys one ClearingHub for TOKEN_ADDRESS.
///
///   TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
///   forge script script/Deploy.s.sol --rpc-url arc_testnet \
///     --private-key $DEPLOYER_PK --broadcast --with-gas-price 25gwei
contract Deploy is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        vm.startBroadcast();
        ClearingHub hub = new ClearingHub(IERC20(token));
        vm.stopBroadcast();
        console.log("ClearingHub deployed for token %s at %s", token, address(hub));
    }
}
