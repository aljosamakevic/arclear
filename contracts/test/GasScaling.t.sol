// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {PvPRoundBuilder} from "./utils/PvPRoundBuilder.sol";
import {ClearingHubV2} from "../src/ClearingHubV2.sol";
import {PvPRouter} from "../src/PvPRouter.sol";

/// @title  Participant-scaling gas measurements for the SDK's write formulas
/// @notice B-CR-03 / B-WR-01: every recorded executeRound measurement was
///         taken at n=5 (ClearingHubV2.t.sol hard-codes `new address[](5)` and
///         varies only m), so the per-participant coefficient in
///         `src/client.ts` was never actually measured. It was too low, and
///         `docs/CALIBRATION.md` analyzes pools at n=15/30/50 — every one of
///         them past the crossover, where a deterministic formula guarantees
///         an out-of-gas revert that burns USDC-denominated fees on Arc.
/// @dev    Two things the older measurements got wrong, both fixed here:
///         1. `gasleft()` deltas EXCLUDE intrinsic gas (21,000 + 16 per
///            non-zero and 4 per zero calldata byte). At these calldata sizes
///            that is a six-figure omission, so every point below reports
///            execution, intrinsic, and the total a submitter actually pays.
///         2. Worst case is not "the n=5 shape with more ids": a participant
///            whose collateral goes 0 -> non-zero pays a 20,000-gas SSTORE
///            (plus another 20,000 for `lastRound`), so the measured shape is
///            one funded debtor and n-1 fresh creditors.
///         Each point asserts the SHIPPED formula covers the total, so the
///         constants in src/client.ts can never silently drift again.
contract GasScalingTest is PvPRoundBuilder {
    // --- src/client.ts formula constants, mirrored (keep the two in sync) ---
    uint256 internal constant EXECUTE_ROUND_GAS_BASE = 300_000;
    uint256 internal constant EXECUTE_ROUND_GAS_PER_PARTICIPANT = 90_000;
    uint256 internal constant EXECUTE_ROUND_GAS_PER_ID = 8_000;
    uint256 internal constant PVP_ROUTER_GAS_BASE = 350_000;
    uint256 internal constant PVP_GAS_PER_UNION_SIG = 15_000;

    function setUp() public {
        _setUpPvP();
    }

    // ------------------------------------------------------------- harness

    /// @dev Replace the 5-actor default with `n` known-key actors, ascending.
    function _expandActors(uint256 n) internal {
        delete keys;
        delete actors;
        uint256[] memory ks = new uint256[](n);
        address[] memory as_ = new address[](n);
        for (uint256 i; i < n; ++i) {
            ks[i] = uint256(keccak256(abi.encode("arclear-gas-actor", i)));
            as_[i] = vm.addr(ks[i]);
        }
        // Insertion sort: participants must be strictly ascending.
        for (uint256 i = 1; i < n; ++i) {
            address a = as_[i];
            uint256 k = ks[i];
            uint256 j = i;
            while (j > 0 && as_[j - 1] > a) {
                as_[j] = as_[j - 1];
                ks[j] = ks[j - 1];
                --j;
            }
            as_[j] = a;
            ks[j] = k;
        }
        for (uint256 i; i < n; ++i) {
            keys.push(ks[i]);
            actors.push(as_[i]);
        }
    }

    /// @dev EIP-2028 intrinsic cost of a transaction carrying `data`: the gas
    ///      a submitter pays before the EVM starts executing, which no
    ///      `gasleft()` delta can ever see.
    function _intrinsicGas(bytes memory data) internal pure returns (uint256 gas) {
        gas = 21_000;
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev Worst-case round shape: actors[0] is the sole (funded) debtor,
    ///      every other participant is a fresh creditor whose collateral and
    ///      lastRound slots both go 0 -> non-zero.
    function _shape(uint256 n)
        internal
        returns (address[] memory p, int256[] memory d)
    {
        p = new address[](n);
        d = new int256[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = actors[i];
        }
        d[0] = -int256((n - 1) * 1e6);
        for (uint256 i = 1; i < n; ++i) {
            d[i] = int256(1e6);
        }
        _fundAndDeposit(hubUSDC, usdc, actors[0], (n - 1) * 1e6);
    }

    function _measureExecuteRound(uint256 n, uint256 m) internal {
        _expandActors(n);
        (address[] memory p, int256[] memory d) = _shape(n);
        bytes32[] memory ids = _manifest(m, keccak256(abi.encode("gas-scale", n, m)));
        bytes[] memory sigs = _buildSignatures(hubUSDC, 0, p, d, ids);

        uint256 intrinsic =
            _intrinsicGas(abi.encodeCall(ClearingHubV2.executeRound, (0, p, d, ids, sigs)));

        uint256 g0 = gasleft();
        hubUSDC.executeRound(0, p, d, ids, sigs);
        uint256 exec = g0 - gasleft();
        assertEq(hubUSDC.roundNonce(), 1, "round must have executed");

        uint256 total = exec + intrinsic;
        uint256 formula = EXECUTE_ROUND_GAS_BASE + EXECUTE_ROUND_GAS_PER_PARTICIPANT * n
            + EXECUTE_ROUND_GAS_PER_ID * m;
        console2.log("executeRound n / m:", n, m);
        console2.log("  exec / intrinsic:", exec, intrinsic);
        console2.log("  total / formula :", total, formula);
        // Margin in basis points of the total, so the log records how much
        // headroom the shipped constants actually carry at this point.
        console2.log("  margin (bps)    :", (formula * 10_000) / total);
        assertLe(total, formula, "shipped executeRound formula under-provisions this point");
    }

    // --------------------------------------------------- executeRound points
    // m = n/2 is the realistic minimum manifest: a participant only appears in
    // a round because one of their IOUs was consumed, so n participants imply
    // at least n/2 consumed ids.

    function test_gas_executeRound_n2() public {
        _measureExecuteRound(2, 1);
    }

    function test_gas_executeRound_n5() public {
        _measureExecuteRound(5, 3);
    }

    function test_gas_executeRound_n15() public {
        _measureExecuteRound(15, 8);
    }

    function test_gas_executeRound_n30() public {
        _measureExecuteRound(30, 15);
    }

    function test_gas_executeRound_n50() public {
        _measureExecuteRound(50, 25);
    }

    /// Demo scale: the shape the hosted demo and e2e actually submit.
    function test_gas_executeRound_n5_m105() public {
        _measureExecuteRound(5, 105);
    }

    /// Manifest-heavy point: pins the per-id coefficient independently of n.
    function test_gas_executeRound_n5_m250() public {
        _measureExecuteRound(5, 250);
    }

    // ------------------------------------------------------ executePvP points

    function _measureExecutePvP(uint256 n, uint256 m) internal {
        _expandActors(n);
        // Both legs over the SAME participant set: union = n, which is the
        // demo's shape and the worst case for the router's union merge.
        address[] memory p = new address[](n);
        int256[] memory d = new int256[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = actors[i];
        }
        d[0] = -int256((n - 1) * 1e6);
        for (uint256 i = 1; i < n; ++i) {
            d[i] = int256(1e6);
        }
        _fundAndDeposit(hubUSDC, usdc, actors[0], (n - 1) * 1e6);
        _fundAndDeposit(hubEURC, eurc, actors[0], (n - 1) * 1e6);

        PvPBundle memory b = _bundle(
            hubUSDC.roundNonce(),
            p,
            d,
            _manifest(m, keccak256(abi.encode("pvp-gas-usdc", n))),
            hubEURC.roundNonce(),
            p,
            d,
            _manifest(m, keccak256(abi.encode("pvp-gas-eurc", n))),
            989_589,
            1_000_000
        );

        uint256 intrinsic = _intrinsicGas(
            abi.encodeCall(
                PvPRouter.executePvP,
                (
                    b.usdcLeg,
                    b.eurcLeg,
                    b.usdcDigest,
                    b.eurcDigest,
                    b.fxNumerator,
                    b.fxDenominator,
                    b.pvpSignatures
                )
            )
        );

        uint256 g0 = gasleft();
        _submit(b);
        uint256 exec = g0 - gasleft();
        assertEq(hubUSDC.roundNonce(), 1, "USDC leg must have executed");
        assertEq(hubEURC.roundNonce(), 1, "EURC leg must have executed");

        uint256 total = exec + intrinsic;
        uint256 formula = PVP_ROUTER_GAS_BASE + 2 * EXECUTE_ROUND_GAS_BASE
            + EXECUTE_ROUND_GAS_PER_PARTICIPANT * 2 * n + EXECUTE_ROUND_GAS_PER_ID * 2 * m
            + PVP_GAS_PER_UNION_SIG * n;
        console2.log("executePvP n per leg / m per leg:", n, m);
        console2.log("  exec / intrinsic:", exec, intrinsic);
        console2.log("  total / formula :", total, formula);
        console2.log("  margin (bps)    :", (formula * 10_000) / total);
        assertLe(total, formula, "shipped executePvP formula under-provisions this point");
    }

    function test_gas_executePvP_n3() public {
        _measureExecutePvP(3, 10);
    }

    function test_gas_executePvP_n5_m105() public {
        _measureExecutePvP(5, 105);
    }

    function test_gas_executePvP_n30() public {
        _measureExecutePvP(30, 15);
    }

    function test_gas_executePvP_n50() public {
        _measureExecutePvP(50, 25);
    }
}
