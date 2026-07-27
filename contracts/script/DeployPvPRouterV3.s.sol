// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";
import {PvPRouterV3} from "../src/PvPRouterV3.sol";

/// Deploys one PvPRouterV3 permanently bound to two ClearingHubV3 deployments
/// (HUB_V3_USDC / HUB_V3_EURC — the README hub table is the source of truth for
/// these addresses). Explicit gas price is mandatory on Arc (USDC is both native
/// gas token and ERC-20):
///
///   HUB_V3_USDC=0x... HUB_V3_EURC=0x... \
///   forge script script/DeployPvPRouterV3.s.sol --rpc-url arc_testnet \
///     --private-key $DEPLOYER_PK --broadcast --with-gas-price 25gwei
///
/// Then verify the source on the Arc Blockscout explorer (same compiler
/// settings as the build; constructor args ABI-encoded):
///
///   forge verify-contract <router> src/PvPRouterV3.sol:PvPRouterV3 \
///     --verifier blockscout --verifier-url https://testnet.arcscan.app/api \
///     --chain-id 5042002 \
///     --constructor-args $(cast abi-encode "constructor(address,address)" \
///       $HUB_V3_USDC $HUB_V3_EURC)
///
/// Post-deploy sanity (must echo the two env addresses back):
///
///   cast call <router> "hubUSDC()(address)" --rpc-url $ARC_RPC_URL
///   cast call <router> "hubEURC()(address)" --rpc-url $ARC_RPC_URL
///
/// WR-07 (both halves). The audit found `DeployPvPRouter.s.sol` reading two
/// unvalidated env vars into immutables the router's own NatSpec calls "the
/// mitigation, not an optimization" for evil-hub substitution. `PvPRouterV3`
/// now rejects a zero address and a same-hub pair on-chain; this script adds
/// the checks a constructor CANNOT usefully make, before broadcasting:
///
///   1. Both addresses have code. A router bound to an EOA would accept
///      bundles and silently no-op every leg call (a call to a codeless
///      address returns success with empty returndata, so `hashRound` would
///      decode garbage and `executeRound` would appear to succeed). The
///      constructor deliberately does NOT check this — `hashPvPRound` never
///      calls a hub, so fixture/parity harnesses construct the router at a
///      fixed address with no hub code present.
///   2. Both are actually ClearingHubV3, probed via `consumed(bytes32)` —
///      V3's consumption ledger, which V2 does not have. Pointing a V3 router
///      at a V2 hub compiles and deploys fine, then fails on the first bundle
///      because the V2 `executeRound` selector differs.
///   3. The hubs clear DIFFERENT tokens. This router exists to settle a
///      cross-currency bundle at an agreed FX rate; two hubs over one ERC-20
///      would make the rate economically meaningless.
contract DeployPvPRouterV3 is Script {
    function run() external {
        address hubUsdc = vm.envAddress("HUB_V3_USDC");
        address hubEurc = vm.envAddress("HUB_V3_EURC");

        require(hubUsdc != address(0), "HUB_V3_USDC is the zero address");
        require(hubEurc != address(0), "HUB_V3_EURC is the zero address");
        require(hubUsdc != hubEurc, "HUB_V3_USDC and HUB_V3_EURC are the same hub");
        require(hubUsdc.code.length > 0, "HUB_V3_USDC has no code");
        require(hubEurc.code.length > 0, "HUB_V3_EURC has no code");

        // Probe V3-ness: `consumed` is V3's ledger and has no V2 counterpart,
        // so this staticcall reverts against a V2 hub (or anything else).
        ClearingHubV3 usdcHub = ClearingHubV3(hubUsdc);
        ClearingHubV3 eurcHub = ClearingHubV3(hubEurc);
        require(!usdcHub.consumed(bytes32(0)), "HUB_V3_USDC is not a ClearingHubV3");
        require(!eurcHub.consumed(bytes32(0)), "HUB_V3_EURC is not a ClearingHubV3");

        address tokenU = address(usdcHub.token());
        address tokenE = address(eurcHub.token());
        require(tokenU != tokenE, "both hubs clear the same token - not a cross-currency pair");

        vm.startBroadcast();
        PvPRouterV3 router = new PvPRouterV3(usdcHub, eurcHub);
        vm.stopBroadcast();

        console.log("PvPRouterV3 deployed at %s", address(router));
        console.log("  hubUSDC (immutable) = %s  token %s", address(router.hubUSDC()), tokenU);
        console.log("  hubEURC (immutable) = %s  token %s", address(router.hubEURC()), tokenE);
        console.log("  EIP-712 domain = ArclearPvPRouterV3 / 1");
    }
}
