// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RoundBuilder, MockUSDC} from "./utils/RoundBuilder.sol";
import {ClearingHub} from "../src/ClearingHub.sol";

contract ClearingHubTest is RoundBuilder {
    bytes32 internal constant MANIFEST = keccak256("manifest-1");

    function setUp() public {
        _setUpActors();
    }

    // ---------------------------------------------------------------- deposits

    function test_depositAndWithdraw() public {
        _fundAndDeposit(actors[0], 100e6);
        assertEq(hub.collateral(actors[0]), 100e6);
        assertEq(usdc.balanceOf(address(hub)), 100e6);

        vm.prank(actors[0]);
        hub.withdraw(40e6);
        assertEq(hub.collateral(actors[0]), 60e6);
        assertEq(usdc.balanceOf(actors[0]), 40e6);
    }

    function test_withdraw_revertsOverBalance() public {
        _fundAndDeposit(actors[0], 10e6);
        vm.prank(actors[0]);
        vm.expectRevert(ClearingHub.InsufficientWithdrawBalance.selector);
        hub.withdraw(11e6);
    }

    function test_zeroAmounts_revert() public {
        vm.expectRevert(ClearingHub.ZeroAmount.selector);
        hub.deposit(0);
        vm.expectRevert(ClearingHub.ZeroAmount.selector);
        hub.withdraw(0);
    }

    function test_withdraw_worksWhilePaused() public {
        _fundAndDeposit(actors[0], 10e6);
        hub.pause();
        vm.prank(actors[0]);
        hub.withdraw(10e6); // exit must never be pausable
        assertEq(usdc.balanceOf(actors[0]), 10e6);
    }

    // ------------------------------------------------------------ happy round

    /// A(-3) B(+1) C(+2): A pays out 3, B and C receive.
    function _simpleRound()
        internal
        view
        returns (address[] memory p, int256[] memory d)
    {
        p = new address[](3);
        d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-3e6), int256(1e6), int256(2e6));
    }

    function test_executeRound_happyPath() public {
        _fundAndDeposit(actors[0], 10e6);
        _fundAndDeposit(actors[1], 5e6);
        // actors[2] never deposited — pure creditor needs no collateral.

        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);

        vm.expectEmit(true, true, false, true);
        emit ClearingHub.RoundExecuted(0, _digest(0, p, d, MANIFEST), MANIFEST, 3, 3e6);
        hub.executeRound(0, p, d, MANIFEST, sigs);

        assertEq(hub.collateral(actors[0]), 7e6);
        assertEq(hub.collateral(actors[1]), 6e6);
        assertEq(hub.collateral(actors[2]), 2e6);
        assertEq(hub.roundNonce(), 1);
        // Collateral conservation: hub token balance untouched by netting.
        assertEq(usdc.balanceOf(address(hub)), 15e6);
    }

    function test_executeRound_zeroDeltaParticipantAllowed() public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](3);
        int256[] memory d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-1e6), int256(0), int256(1e6));
        hub.executeRound(0, p, d, MANIFEST, _buildSignatures(0, p, d, MANIFEST));
        assertEq(hub.collateral(actors[1]), 0);
        assertEq(hub.roundNonce(), 1);
    }

    function test_executeRound_permissionless() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        vm.prank(makeAddr("random-relayer"));
        hub.executeRound(0, p, d, MANIFEST, sigs);
        assertEq(hub.roundNonce(), 1);
    }

    // ------------------------------------------------------------ revert matrix

    function test_revert_wrongNonce() public {
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(7, p, d, MANIFEST);
        vm.expectRevert(abi.encodeWithSelector(ClearingHub.WrongRoundNonce.selector, 0, 7));
        hub.executeRound(7, p, d, MANIFEST, sigs);
    }

    function test_revert_replaySameRound() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        hub.executeRound(0, p, d, MANIFEST, sigs);
        vm.expectRevert(abi.encodeWithSelector(ClearingHub.WrongRoundNonce.selector, 1, 0));
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_unsortedParticipants() public {
        (address[] memory p, int256[] memory d) = _simpleRound();
        (p[0], p[1]) = (p[1], p[0]); // break ordering (deltas now misaligned too)
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        vm.expectRevert(ClearingHub.ParticipantsNotStrictlyAscending.selector);
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_duplicateParticipant() public {
        (address[] memory p, int256[] memory d) = _simpleRound();
        p[1] = p[0];
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        vm.expectRevert(ClearingHub.ParticipantsNotStrictlyAscending.selector);
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_lengthMismatch() public {
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = new bytes[](2);
        vm.expectRevert(ClearingHub.LengthMismatch.selector);
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_tooFewParticipants() public {
        address[] memory p = new address[](1);
        int256[] memory d = new int256[](1);
        p[0] = actors[0];
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(ClearingHub.TooFewParticipants.selector);
        hub.executeRound(0, p, d, bytes32(0), sigs);
    }

    function test_revert_nonZeroSum() public {
        (address[] memory p, int256[] memory d) = _simpleRound();
        d[2] = 3e6; // sum = +1e6
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        vm.expectRevert(abi.encodeWithSelector(ClearingHub.DeltasDoNotSumToZero.selector, int256(1e6)));
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_missingConsent() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        // participant 1's consent replaced by participant 0 signing again
        sigs[1] = sigs[0];
        vm.expectRevert(abi.encodeWithSelector(ClearingHub.BadSignature.selector, 1));
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_tamperedDelta() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        // coordinator flips a delta after collecting consents (still zero-sum)
        d[1] = 2e6;
        d[2] = 1e6;
        vm.expectRevert(abi.encodeWithSelector(ClearingHub.BadSignature.selector, 0));
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_tamperedManifest() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        vm.expectRevert(abi.encodeWithSelector(ClearingHub.BadSignature.selector, 0));
        hub.executeRound(0, p, d, keccak256("other-manifest"), sigs);
    }

    function test_revert_insufficientCollateral() public {
        _fundAndDeposit(actors[0], 1e6); // needs 3e6
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHub.InsufficientCollateral.selector, actors[0], 1e6, 3e6)
        );
        hub.executeRound(0, p, d, MANIFEST, sigs);
    }

    /// Withdraw-front-run: debtor consents, then withdraws before execution.
    /// The round reverts in full — no partial settlement is possible.
    function test_revert_withdrawFrontRunsExecution() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);

        vm.prank(actors[0]);
        hub.withdraw(9e6);

        vm.expectRevert(
            abi.encodeWithSelector(ClearingHub.InsufficientCollateral.selector, actors[0], 1e6, 3e6)
        );
        hub.executeRound(0, p, d, MANIFEST, sigs);
        // untouched state: creditors received nothing
        assertEq(hub.collateral(actors[1]), 0);
        assertEq(hub.collateral(actors[2]), 0);
    }

    function test_revert_crossHubReplay() public {
        // Same participants sign a round for hub A; submitting to hub B must fail
        // because the EIP-712 domain binds the verifying contract (per-token hub).
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST); // signed for `hub`

        ClearingHub hubB = new ClearingHub(usdc);
        vm.expectRevert(abi.encodeWithSelector(ClearingHub.BadSignature.selector, 0));
        hubB.executeRound(0, p, d, MANIFEST, sigs);
    }

    function test_revert_whenPaused() public {
        hub.pause();
        (address[] memory p, int256[] memory d) = _simpleRound();
        bytes[] memory sigs = _buildSignatures(0, p, d, MANIFEST);
        vm.expectRevert();
        hub.executeRound(0, p, d, MANIFEST, sigs);
        vm.expectRevert();
        hub.deposit(1e6);
    }

    function test_pause_onlyOwner() public {
        vm.prank(actors[0]);
        vm.expectRevert();
        hub.pause();
    }

    // ---------------------------------------------------------- digest parity

    function test_hashRound_matchesLocalEncoding() public view {
        (address[] memory p, int256[] memory d) = _simpleRound();
        assertEq(hub.hashRound(0, p, d, MANIFEST), _digest(0, p, d, MANIFEST));
    }
}
