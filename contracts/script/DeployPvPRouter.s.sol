// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";
import {PvPRouter} from "../src/PvPRouter.sol";

/// Deploys one PvPRouter permanently bound to the two live ClearingHubV2
/// deployments (HUB_V2_USDC / HUB_V2_EURC — the README hub table is the
/// source of truth for these addresses). Explicit gas price is mandatory on
/// Arc (USDC is both native gas token and ERC-20):
///
///   HUB_V2_USDC=0x3b9a9617b91589a15A14122183e6305D9F0a5a16 \
///   HUB_V2_EURC=0xECcCD7E43B0Caf4D81420483dEE20E5e258FB85E \
///   forge script script/DeployPvPRouter.s.sol --rpc-url arc_testnet \
///     --private-key $DEPLOYER_PK --broadcast --with-gas-price 25gwei
///
/// Then verify the source on the Arc Blockscout explorer (same compiler
/// settings as the build; constructor args ABI-encoded):
///
///   forge verify-contract <router> src/PvPRouter.sol:PvPRouter \
///     --verifier blockscout --verifier-url https://testnet.arcscan.app/api \
///     --chain-id 5042002 \
///     --constructor-args $(cast abi-encode "constructor(address,address)" \
///       $HUB_V2_USDC $HUB_V2_EURC)
///
/// Post-deploy sanity (must echo the two env addresses back):
///
///   cast call <router> "hubUSDC()(address)" --rpc-url $ARC_RPC_URL
///   cast call <router> "hubEURC()(address)" --rpc-url $ARC_RPC_URL
contract DeployPvPRouter is Script {
    function run() external {
        address hubUsdc = vm.envAddress("HUB_V2_USDC");
        address hubEurc = vm.envAddress("HUB_V2_EURC");
        vm.startBroadcast();
        PvPRouter router = new PvPRouter(ClearingHubV2(hubUsdc), ClearingHubV2(hubEurc));
        vm.stopBroadcast();
        console.log("PvPRouter deployed at %s", address(router));
        console.log("  hubUSDC (immutable) = %s", address(router.hubUSDC()));
        console.log("  hubEURC (immutable) = %s", address(router.hubEURC()));
    }
}
