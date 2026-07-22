// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RoundBuilder} from "./utils/RoundBuilder.sol";
import {ClearingHub} from "../src/ClearingHub.sol";

contract ClearingHubFuzzTest is RoundBuilder {
    function setUp() public {
        _setUpActors();
    }

    /// Random bilateral flows among the 5 actors → net in-test → sign → execute.
    /// Asserts: per-account balances move exactly by net positions and the hub's
    /// token balance is conserved (netting never mints or burns).
    function testFuzz_roundExecution(uint256 seed) public {
        // 1. random gross flow matrix (like a day of micropayments)
        int256[] memory net = new int256[](ACTORS);
        uint256 gross;
        for (uint256 i; i < ACTORS; ++i) {
            for (uint256 j; j < ACTORS; ++j) {
                if (i == j) continue;
                // amount in [0, 1e6) base units per pair
                uint256 amt = uint256(keccak256(abi.encode(seed, i, j))) % 1e6;
                net[i] -= int256(amt); // i owes j
                net[j] += int256(amt);
                gross += amt;
            }
        }

        // 2. fund every debtor to exactly cover their net debit (plus jitter)
        for (uint256 i; i < ACTORS; ++i) {
            if (net[i] < 0) {
                uint256 pad = uint256(keccak256(abi.encode(seed, "pad", i))) % 1e6;
                _fundAndDeposit(actors[i], uint256(-net[i]) + pad);
            }
        }
        uint256 hubBalanceBefore = usdc.balanceOf(address(hub));
        uint256[] memory before_ = new uint256[](ACTORS);
        for (uint256 i; i < ACTORS; ++i) {
            before_[i] = hub.collateral(actors[i]);
        }

        // 3. execute (actors[] is already ascending)
        bytes32 manifest = keccak256(abi.encode("manifest", seed));
        int256 sum;
        for (uint256 i; i < ACTORS; ++i) {
            sum += net[i];
        }
        assertEq(sum, 0, "test-internal: net must be zero-sum");

        address[] memory p = new address[](ACTORS);
        for (uint256 i; i < ACTORS; ++i) {
            p[i] = actors[i];
        }
        hub.executeRound(0, p, net, manifest, _buildSignatures(0, p, net, manifest));

        // 4. invariants
        for (uint256 i; i < ACTORS; ++i) {
            int256 expected = int256(before_[i]) + net[i];
            assertEq(int256(hub.collateral(actors[i])), expected, "collateral delta != net");
        }
        assertEq(usdc.balanceOf(address(hub)), hubBalanceBefore, "hub balance not conserved");
        assertEq(hub.roundNonce(), 1);
    }

    /// Any perturbation of a consented round must revert: flip one byte of one
    /// signature, or nudge one delta pair (keeping zero-sum).
    function testFuzz_perturbationAlwaysReverts(uint256 seed, bool tamperSig) public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](3);
        int256[] memory d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        bytes32 manifest = keccak256("m");
        bytes[] memory sigs = _buildSignatures(0, p, d, manifest);

        if (tamperSig) {
            uint256 sigIdx = seed % 3;
            uint256 byteIdx = uint256(keccak256(abi.encode(seed))) % 65;
            bytes memory s = sigs[sigIdx];
            s[byteIdx] = bytes1(uint8(s[byteIdx]) ^ uint8(1 + (seed % 255)));
            sigs[sigIdx] = s;
        } else {
            int256 nudge = int256(1 + (seed % 1e6));
            d[1] += nudge;
            d[2] -= nudge; // still zero-sum, but not what anyone signed
        }

        vm.expectRevert();
        hub.executeRound(0, p, d, manifest, sigs);
        assertEq(hub.roundNonce(), 0, "state must be untouched");
    }
}
