// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {RoundBuilderV3} from "./utils/RoundBuilderV3.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";

/// @title  Participant- and manifest-scaling gas measurements for ClearingHubV3
/// @notice V3 sibling of GasScaling.t.sol. Wave B fits the SDK's write-gas
///         formula from these points, so they carry the same two corrections
///         that file introduced (B-CR-03 / B-WR-01):
///
///         1. `gasleft()` deltas EXCLUDE intrinsic gas (21,000 + 16 per
///            non-zero and 4 per zero calldata byte). V3's `ConsumedRef` is
///            three ABI words per entry instead of one bytes32, so the calldata
///            term grew and reporting execution-only would understate the bill
///            a submitter actually pays. Every point reports execution,
///            intrinsic, and the total.
///         2. Worst case is not "the n=5 shape with more ids": a participant
///            whose collateral goes 0 -> non-zero pays a 20,000-gas SSTORE
///            (plus another for `lastRound`), so the measured shape is one
///            funded debtor and n-1 fresh creditors, on a fresh hub at nonce 0.
///
/// @dev    The per-entry coefficient is where V3 diverges sharply from V2, and
///         the divergence is deliberate. Each `ConsumedRef` now costs a COLD
///         SSTORE into the permanent `consumed` ledger (20,000 + 2,100) on top
///         of the merkle work V2 already did, taking the marginal entry from
///         ~4,400 gas to ~30,000. That is the price of closing CR-02: V2's
///         cheaper round bought a redemption guarantee that any third party
///         could permanently destroy. The counterpart saving is on the other
///         side of the product — `redeemIOU` drops from 199,604 gas (a
///         16-proof ring walk) to ~60,600, and is now INDEPENDENT of history
///         depth, which `test_gas_v3_redeemIOU_isHistoryIndependent` pins.
///
///         The constants below are the FITTED V3 formula, pinned by assertLe at
///         every point. They are intentionally the same shape as the V2
///         constants in src/client.ts so Wave B can swap them in directly.
contract GasScalingV3Test is RoundBuilderV3 {
    // --- fitted V3 write-gas formula (Wave B: mirror into src/client.ts) ---
    uint256 internal constant EXECUTE_ROUND_GAS_BASE = 300_000;
    uint256 internal constant EXECUTE_ROUND_GAS_PER_PARTICIPANT = 90_000;
    uint256 internal constant EXECUTE_ROUND_GAS_PER_ID = 45_000;
    uint256 internal constant REDEEM_IOU_GAS = 150_000;

    function setUp() public {
        _setUpActors();
    }

    // ------------------------------------------------------------- harness

    /// @dev Fresh hub at nonce 0 plus `n` known-key actors, ascending, so every
    ///      point measures all-cold storage.
    function _freshHub(uint256 n) internal {
        hub = new ClearingHubV3(usdc, K);
        delete keys;
        delete actors;
        uint256[] memory ks = new uint256[](n);
        address[] memory as_ = new address[](n);
        for (uint256 i; i < n; ++i) {
            ks[i] = uint256(keccak256(abi.encode("arclear-gas-actor", i)));
            as_[i] = vm.addr(ks[i]);
        }
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

    /// @dev EIP-2028 intrinsic cost of a transaction carrying `data`: the gas a
    ///      submitter pays before the EVM starts executing, which no
    ///      `gasleft()` delta can ever see.
    function _intrinsicGas(bytes memory data) internal pure returns (uint256 gas) {
        gas = 21_000;
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// @dev One funded debtor, n-1 fresh creditors.
    function _shape(uint256 n) internal returns (address[] memory p, int256[] memory d) {
        p = new address[](n);
        d = new int256[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = actors[i];
        }
        d[0] = -int256((n - 1) * 1e6);
        for (uint256 i = 1; i < n; ++i) {
            d[i] = int256(1e6);
        }
        _fundAndDeposit(actors[0], (n - 1) * 1e6);
    }

    function _measure(uint256 n, uint256 m) internal returns (uint256 total) {
        _freshHub(n);
        (address[] memory p, int256[] memory d) = _shape(n);
        ClearingHubV3.ConsumedRef[] memory refs =
            _manifest(p, m, keccak256(abi.encode("gas-scale-v3", n, m)));
        bytes[] memory sigs = _buildSignatures(0, p, d, refs);

        uint256 intrinsic =
            _intrinsicGas(abi.encodeCall(ClearingHubV3.executeRound, (0, p, d, refs, sigs)));

        uint256 g0 = gasleft();
        hub.executeRound(0, p, d, refs, sigs);
        uint256 exec = g0 - gasleft();
        assertEq(hub.roundNonce(), 1, "round must have executed");

        total = exec + intrinsic;
        uint256 formula = EXECUTE_ROUND_GAS_BASE + EXECUTE_ROUND_GAS_PER_PARTICIPANT * n
            + EXECUTE_ROUND_GAS_PER_ID * m;
        console2.log("V3 executeRound n / m:", n, m);
        console2.log("  exec / intrinsic:", exec, intrinsic);
        console2.log("  total / formula :", total, formula);
        console2.log("  margin (bps)    :", (formula * 10_000) / total);
        assertLe(total, formula, "fitted V3 executeRound formula under-provisions this point");
    }

    // ----------------------------------------------- realistic (m = n/2) points
    // A participant only appears in a round because one of their IOUs was
    // consumed, so n participants imply at least n/2 consumed entries. These are
    // the like-for-like counterparts of GasScaling.t.sol's V2 points.

    function test_gas_v3_executeRound_n2() public {
        _measure(2, 1);
    }

    function test_gas_v3_executeRound_n5() public {
        _measure(5, 3);
    }

    function test_gas_v3_executeRound_n15() public {
        _measure(15, 8);
    }

    function test_gas_v3_executeRound_n30() public {
        _measure(30, 15);
    }

    function test_gas_v3_executeRound_n50() public {
        _measure(50, 25);
    }

    /// Demo scale: the shape the hosted demo and e2e actually submit.
    function test_gas_v3_executeRound_n5_m105() public {
        _measure(5, 105);
    }

    /// Manifest-heavy point: pins the per-entry coefficient independently of n.
    function test_gas_v3_executeRound_n5_m250() public {
        _measure(5, 250);
    }

    // ----------------------------------------------------------- marginal fits
    //
    // Two isolated series so Wave B can read the coefficients off directly
    // rather than solving a 2-variable fit from mixed points.

    /// Participant marginal: m pinned at 1, n swept. Reports the per-participant
    /// slope between consecutive points and overall.
    function test_gas_v3_participantMarginal() public {
        uint256[5] memory ns = [uint256(2), 5, 15, 30, 50];
        uint256[5] memory totals;
        for (uint256 i; i < 5; ++i) {
            totals[i] = _measure(ns[i], 1);
        }
        console2.log("--- V3 per-participant marginal (m pinned at 1) ---");
        for (uint256 i = 1; i < 5; ++i) {
            console2.log(
                "  n step, gas per added participant:",
                ns[i],
                (totals[i] - totals[i - 1]) / (ns[i] - ns[i - 1])
            );
        }
        console2.log(
            "  overall n=2..50 per participant:", (totals[4] - totals[0]) / (ns[4] - ns[0])
        );
    }

    /// Manifest marginal: n pinned at 5, m swept. Reports the per-entry slope.
    function test_gas_v3_manifestMarginal() public {
        uint256[4] memory ms = [uint256(1), 10, 105, 250];
        uint256[4] memory totals;
        for (uint256 i; i < 4; ++i) {
            totals[i] = _measure(5, ms[i]);
        }
        console2.log("--- V3 per-consumed-entry marginal (n pinned at 5) ---");
        for (uint256 i = 1; i < 4; ++i) {
            console2.log(
                "  m step, gas per added entry:",
                ms[i],
                (totals[i] - totals[i - 1]) / (ms[i] - ms[i - 1])
            );
        }
        console2.log("  overall m=1..250 per entry:", (totals[3] - totals[0]) / (ms[3] - ms[0]));
    }

    // -------------------------------------------------------------- redeemIOU

    /// @dev Stale a fresh debtor over `rounds` executed rounds, then measure the
    ///      redemption a creditor actually pays for, intrinsic included.
    function _measureRedeem(uint256 rounds) internal returns (uint256 total, uint256 exec) {
        _freshHub(ACTORS);
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 r; r < rounds; ++r) {
            _executeRoundWithout(actors[0], 8);
        }

        uint256 intrinsic = _intrinsicGas(abi.encodeCall(ClearingHubV3.redeemIOU, (iou, sig)));
        uint256 g0 = gasleft();
        hub.redeemIOU(iou, sig);
        exec = g0 - gasleft();
        assertEq(hub.collateral(actors[1]), 5e6, "redemption must have settled");

        total = exec + intrinsic;
        console2.log("V3 redeemIOU after rounds:", rounds);
        console2.log("  exec / intrinsic:", exec, intrinsic);
        console2.log("  total / formula :", total, REDEEM_IOU_GAS);
        assertLe(total, REDEEM_IOU_GAS, "fitted V3 redeemIOU budget under-provisions this point");
    }

    /// The property the root ring could never offer: redemption cost does not
    /// depend on how much history the hub has accumulated. V2's counterpart
    /// walked RING=16 non-inclusion proofs for 199,604 gas and would have grown
    /// linearly with any larger ring.
    function test_gas_v3_redeemIOU_isHistoryIndependent() public {
        (uint256 shallowTotal, uint256 shallowExec) = _measureRedeem(4);
        (uint256 deepTotal, uint256 deepExec) = _measureRedeem(64);
        // Execution gas is exactly equal: the redemption path touches no
        // per-round state at all. The totals differ by a handful of gas only
        // because each point deploys a fresh hub, so the EIP-712 domain
        // separator — and therefore the signature's zero-byte count, and
        // therefore EIP-2028 intrinsic gas — differs. That jitter is an artifact
        // of the measurement, not of history depth.
        assertEq(deepExec, shallowExec, "redeemIOU must be O(1) in history depth");
        assertApproxEqAbs(deepTotal, shallowTotal, 64, "intrinsic jitter beyond signature entropy");
        console2.log("V3 redeemIOU execution is history-independent at:", deepExec);
    }
}
