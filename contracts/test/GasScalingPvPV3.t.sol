// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {PvPRoundBuilderV3} from "./utils/PvPRoundBuilderV3.sol";
import {MockUSDC} from "./utils/RoundBuilder.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";
import {PvPRouterV3} from "../src/PvPRouterV3.sol";

/// @title  executePvP gas scaling for PvPRouterV3
/// @notice The PvP counterpart of GasScalingV3.t.sol, carrying the same two
///         measurement corrections that file introduced (B-CR-03 / B-WR-01):
///
///         1. `gasleft()` deltas EXCLUDE intrinsic gas (21,000 + 16 per
///            non-zero and 4 per zero calldata byte). A PvP bundle is the
///            largest calldata payload in the system — two full rounds plus a
///            union signature set — so reporting execution-only would
///            understate the bill a submitter actually pays by a wide margin.
///            Every point reports execution, intrinsic and the total.
///         2. Worst case is all-cold: fresh hubs at nonce 0, one funded debtor
///            per leg and n-1 fresh creditors, so every collateral and
///            `lastRound` write is a 20,000-gas cold SSTORE.
///
/// @dev    The fitted formula is additive in four terms, because that is what
///         the router's and hubs' work decomposes into:
///
///           gas <= BASE
///                + PER_PARTICIPANT * (nUsdc + nEurc)
///                + PER_UNION_SIG   * unionSize
///                + PER_REF         * (mUsdc + mEurc)
///
///         Participants and union members are counted separately on purpose.
///         A participant costs its hub an ecrecover, two cold SSTOREs and a
///         `PositionSettled` log; a union member costs the router only one
///         ecrecover over an already-computed digest. Identical participant
///         sets collapse the union to n while keeping 2n participants, and
///         disjoint sets take it to 2n — the two regimes bracket the
///         coefficient from both sides, which is why both are measured.
///
///         Per-ref cost is dominated by V3's cold SSTORE into the permanent
///         `consumed` ledger (20,000 + 2,100) plus the merkle work, which the
///         router pays for a SECOND time when it derives the leg digest
///         (audit IN-07: the hub cannot trust a caller-supplied root, so the
///         duplication is structural).
///
///         The constants below are the FITTED formula, pinned by assertLe at
///         every point — same shape as GasScalingV3's, so Wave B can lift them
///         straight into the SDK's PvP write-gas estimate.
contract GasScalingPvPV3Test is PvPRoundBuilderV3 {
    // --- fitted executePvP gas formula (Wave B: mirror into src/client.ts) ---
    //
    // Fitted from the measured marginals below, then rounded up:
    //   per participant PAIR (identical sets)  117,956  -> 2*62,000 + 9,000
    //   per union signature                      6,303  ->   9,000
    //   per ref PAIR (worst slope, m=105..250)  71,558  -> 2*40,000
    //   base                                            ->  80,000
    // Every point below is pinned in BOTH directions: assertLe against the
    // formula (never under-provision a gas limit) and assertLe of the formula
    // against 1.5x the measurement (never let the estimate rot into a number
    // so loose it stops meaning anything). Measured headroom is 14-25%.
    uint256 internal constant PVP_GAS_BASE = 80_000;
    uint256 internal constant PVP_GAS_PER_PARTICIPANT = 62_000;
    uint256 internal constant PVP_GAS_PER_UNION_SIG = 9_000;
    uint256 internal constant PVP_GAS_PER_REF = 40_000;

    function setUp() public {
        _setUpPvPV3();
    }

    // ------------------------------------------------------------- harness

    /// @dev Fresh hub pair + router at nonce 0 plus `n` known-key actors,
    ///      ascending, so every point measures all-cold storage.
    function _freshEnv(uint256 n) internal {
        usdc = new MockUSDC();
        eurc = new MockUSDC();
        hubUSDC = new ClearingHubV3(usdc, K);
        hubEURC = new ClearingHubV3(eurc, K);
        router = new PvPRouterV3(hubUSDC, hubEURC);

        delete keys;
        delete actors;
        uint256[] memory ks = new uint256[](n);
        address[] memory as_ = new address[](n);
        for (uint256 i; i < n; ++i) {
            ks[i] = uint256(keccak256(abi.encode("arclear-pvp-gas-actor", i)));
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

    /// @dev One funded debtor, n-1 fresh creditors, drawn from actors[offset..].
    function _shape(uint256 offset, uint256 n)
        internal
        view
        returns (address[] memory p, int256[] memory d)
    {
        p = new address[](n);
        d = new int256[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = actors[offset + i];
        }
        d[0] = -int256((n - 1) * 1e6);
        for (uint256 i = 1; i < n; ++i) {
            d[i] = int256(1e6);
        }
    }

    /// @dev Measure one point. `disjoint` selects the union regime: disjoint
    ///      participant sets give union == 2n (every signer attests once per
    ///      leg they are in, but the union still names them once), identical
    ///      sets collapse it to n.
    function _measure(uint256 n, uint256 m, bool disjoint) internal returns (uint256 total) {
        _freshEnv(disjoint ? 2 * n : n);
        (address[] memory pU, int256[] memory dU) = _shape(0, n);
        (address[] memory pE, int256[] memory dE) = _shape(disjoint ? n : 0, n);
        _fundAndDeposit(hubUSDC, usdc, pU[0], (n - 1) * 1e6);
        _fundAndDeposit(hubEURC, eurc, pE[0], (n - 1) * 1e6);

        PvPBundle memory b = _bundle(
            _spec(0, pU, dU, _manifest(pU, m, keccak256(abi.encode("pvp-gas-u", n, m, disjoint)))),
            _spec(0, pE, dE, _manifest(pE, m, keccak256(abi.encode("pvp-gas-e", n, m, disjoint)))),
            989_589,
            1_000_000
        );
        uint256 union_ = b.pvpSignatures.length;
        assertEq(union_, disjoint ? 2 * n : n, "union size regime");

        uint256 intrinsic = _intrinsicGas(_submitCalldata(b));
        uint256 g0 = gasleft();
        _submit(b);
        uint256 exec = g0 - gasleft();
        assertEq(hubUSDC.roundNonce(), 1, "USDC leg must have executed");
        assertEq(hubEURC.roundNonce(), 1, "EURC leg must have executed");

        total = exec + intrinsic;
        uint256 formula = PVP_GAS_BASE + PVP_GAS_PER_PARTICIPANT * 2 * n
            + PVP_GAS_PER_UNION_SIG * union_ + PVP_GAS_PER_REF * 2 * m;
        console2.log("executePvP n/leg, m/leg, union:", n, m, union_);
        console2.log("  exec / intrinsic:", exec, intrinsic);
        console2.log("  total / formula :", total, formula);
        console2.log("  margin (bps)    :", (formula * 10_000) / total);
        assertLe(total, formula, "fitted executePvP formula under-provisions this point");
        assertLe(formula, (total * 3) / 2, "fitted executePvP formula over-provisions this point");
    }

    // ------------------------------------------------- leg-size sweep (identical sets)
    // A participant only appears in a round because one of their IOUs was
    // consumed, so n participants imply at least n/2 consumed entries.

    function test_gas_pvp_n2() public {
        _measure(2, 1, false);
    }

    function test_gas_pvp_n3() public {
        _measure(3, 2, false);
    }

    function test_gas_pvp_n5() public {
        _measure(5, 3, false);
    }

    function test_gas_pvp_n15() public {
        _measure(15, 8, false);
    }

    function test_gas_pvp_n30() public {
        _measure(30, 15, false);
    }

    /// Demo scale: the shape the hosted demo and e2e actually submit, per leg.
    function test_gas_pvp_n5_m105() public {
        _measure(5, 105, false);
    }

    /// Manifest-heavy: pins the per-ref coefficient independently of n. This
    /// is a COEFFICIENT PROBE, not a shippable shape — 500 refs across the two
    /// legs costs ~17.4M gas, and even demo scale (105 refs per leg) costs
    /// ~7.3M. A PvP bundle is two rounds in one transaction, so it hits any
    /// block gas ceiling at roughly half the manifest size a single round can
    /// carry; coordinators must size bundles against the ceiling, not against
    /// the single-round numbers in GasScalingV3.
    function test_gas_pvp_n5_m250() public {
        _measure(5, 250, false);
    }

    // ---------------------------------------------- union regime (disjoint sets)

    function test_gas_pvp_n3_disjoint() public {
        _measure(3, 2, true);
    }

    function test_gas_pvp_n10_disjoint() public {
        _measure(10, 5, true);
    }

    // ----------------------------------------------------------- marginal fits
    //
    // Isolated series so Wave B can read each coefficient off directly rather
    // than solving a 3-variable fit from mixed points.

    /// Participant marginal: m pinned at 1, n swept, identical sets (so the
    /// union grows in lockstep with n and this slope is the COMBINED
    /// per-participant + per-union-sig cost for that regime).
    function test_gas_pvp_participantMarginal() public {
        uint256[4] memory ns = [uint256(2), 5, 15, 30];
        uint256[4] memory totals;
        for (uint256 i; i < 4; ++i) {
            totals[i] = _measure(ns[i], 1, false);
        }
        console2.log("--- per-participant marginal (m=1/leg, identical sets) ---");
        for (uint256 i = 1; i < 4; ++i) {
            console2.log(
                "  n step, gas per added participant PAIR:",
                ns[i],
                (totals[i] - totals[i - 1]) / (ns[i] - ns[i - 1])
            );
        }
        console2.log("  overall n=2..30 per pair:", (totals[3] - totals[0]) / (ns[3] - ns[0]));
    }

    /// Ref marginal: n pinned at 5, m swept. Reports the per-ref slope (per
    /// leg PAIR — each step adds one ref to BOTH legs).
    function test_gas_pvp_refMarginal() public {
        uint256[4] memory ms = [uint256(1), 10, 105, 250];
        uint256[4] memory totals;
        for (uint256 i; i < 4; ++i) {
            totals[i] = _measure(5, ms[i], false);
        }
        console2.log("--- per-ref marginal (n=5/leg) ---");
        for (uint256 i = 1; i < 4; ++i) {
            console2.log(
                "  m step, gas per added ref PAIR:",
                ms[i],
                (totals[i] - totals[i - 1]) / (ms[i] - ms[i - 1])
            );
        }
        console2.log("  overall m=1..250 per pair:", (totals[3] - totals[0]) / (ms[3] - ms[0]));
    }

    /// Union marginal, isolated: the SAME participant count per leg measured in
    /// both regimes. Identical sets give union=n, disjoint gives union=2n, so
    /// the difference is n extra union ecrecovers plus their calldata — and
    /// nothing else changes on the hub side.
    function test_gas_pvp_unionMarginal() public {
        uint256 n = 10;
        uint256 identical = _measure(n, 5, false);
        uint256 disjointTotal = _measure(n, 5, true);
        console2.log("--- union marginal at n=10/leg, m=5/leg ---");
        console2.log("  identical (union=10) :", identical);
        console2.log("  disjoint  (union=20) :", disjointTotal);
        console2.log("  gas per added union signature:", (disjointTotal - identical) / n);
    }
}
