// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RoundBuilderV3} from "./utils/RoundBuilderV3.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";
import {ManifestMerkle} from "../src/lib/ManifestMerkle.sol";

/// @title  ClearingHubV3 — full port of the V2 suite plus the V3-only surface
/// @notice Every assertion ClearingHubV2.t.sol made is reproduced here against
///         V3, so the CR-01/CR-02 fixes cannot have regressed anything V2
///         proved. The attack proofs themselves live in ClearingHubV3PoC.t.sol.
contract ClearingHubV3Test is RoundBuilderV3 {
    function setUp() public {
        _setUpActors();
    }

    /// Fund the debtor (actors[0]), sign an L-convention IOU to actors[1],
    /// then stale the debtor on the ON-CHAIN clock: K executed rounds without
    /// them (Pitfall 4 — never coordinator counters).
    function _staleSetup()
        internal
        returns (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id)
    {
        _fundAndDeposit(actors[0], 10e6);
        iou = _makeIou(actors[0], actors[1], 5e6, 1);
        sig = _signIou(keys[0], iou);
        id = hub.hashIou(iou);
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }
    }

    // ------------------------------------------------- party-bound manifests

    /// The local harness mirror of the leaf derivation must be byte-equal to
    /// the chain's — the same dual-implementation discipline the merkle library
    /// and the EIP-712 digests already carry.
    function test_manifestLeafId_parityWithHarnessMirror() public view {
        bytes32 id = keccak256("some-iou");
        assertEq(
            hub.manifestLeafId(id, actors[0], actors[1]),
            _leafId(id, actors[0], actors[1]),
            "harness mirror diverged from on-chain manifestLeafId"
        );
    }

    /// Ordering the party pair is what removes the role-swap footgun: a
    /// coordinator that lists (creditor, debtor) commits the SAME leaf the
    /// creditor will later prove non-inclusion against, so a genuinely-netted
    /// IOU can never stay redeemable through an argument-order slip.
    function test_manifestLeafId_isPairOrderInsensitive() public view {
        bytes32 id = keccak256("some-iou");
        assertEq(
            hub.manifestLeafId(id, actors[0], actors[1]),
            hub.manifestLeafId(id, actors[1], actors[0]),
            "leaf must not depend on party argument order"
        );
    }

    /// Different party pairs over the SAME id commit different leaves. This is
    /// the whole of the CR-01 fix in one assertion.
    function test_manifestLeafId_differsAcrossPartyPairs() public view {
        bytes32 id = keccak256("some-iou");
        assertTrue(
            hub.manifestLeafId(id, actors[0], actors[1])
                != hub.manifestLeafId(id, actors[3], actors[4]),
            "an unrelated pair must not be able to commit the honest leaf"
        );
    }

    // ------------------------------------------------- executeRound evolution

    function test_executeRound_writesRootRing() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d, ClearingHubV3.ConsumedRef[] memory refs) =
            _simpleRound();
        _execute(p, d, refs);

        (bytes32 root, uint64 nonce_, uint64 executedAt) = hub.rootRing(0);
        assertEq(root, ManifestMerkle.rootOf(_leaves(p, refs)), "ring root != derived root");
        assertEq(nonce_, 0, "ring nonce");
        assertEq(executedAt, uint64(block.timestamp), "ring executedAt");
    }

    function test_executeRound_writesLastRoundForAllParticipants() public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](3);
        int256[] memory d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-1e6), int256(0), int256(1e6));
        _execute(p, d, _manifest(p, 2, "lastround"));

        // 1-based marker nonce+1 for EVERY participant, zero-delta included:
        // their netted paper was consumed, participation is consent.
        assertEq(hub.lastRound(actors[0]), 1, "debtor lastRound");
        assertEq(hub.lastRound(actors[1]), 1, "zero-delta consenter lastRound");
        assertEq(hub.lastRound(actors[2]), 1, "creditor lastRound");
        assertEq(hub.lastRound(actors[3]), 0, "non-participant untouched");
    }

    /// The sorted-manifest guard now orders DERIVED LEAVES, not raw ids — the
    /// SDK's sort key changes with it.
    function test_revert_executeRound_unsortedConsumedRefs() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 2, "ordering-guard");
        (refs[0], refs[1]) = (refs[1], refs[0]); // now descending by leaf
        // rootOf reverts before any signature work — garbage sigs suffice.
        vm.expectRevert(abi.encodeWithSelector(ManifestMerkle.UnsortedLeaves.selector, 1));
        hub.executeRound(0, p, d, refs, new bytes[](2));
    }

    /// Exclusivity, redeem->cannot-net direction (D-14): a redeemed id in a
    /// later round's manifest reverts executeRound before signature checks.
    function test_revert_executeRound_nullifiedId() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        hub.redeemIOU(iou, sig, _proofsForIou(iou));

        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = _refFor(p, id, iou.debtor, iou.creditor);
        uint64 nonce_ = hub.roundNonce();
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.NullifiedIdInManifest.selector, id));
        hub.executeRound(nonce_, p, d, refs, new bytes[](2));
    }

    // ---------------------------------------------------- V3-only round gates

    /// CR-01 input validation: a ref may only name participants of THIS round.
    /// Both indices are checked, and both are checked before any signature work.
    function test_revert_executeRound_partyIndexOutOfRange() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);

        ClearingHubV3.ConsumedRef[] memory badA = new ClearingHubV3.ConsumedRef[](1);
        badA[0] = ClearingHubV3.ConsumedRef({id: keccak256("x"), partyAIdx: 2, partyBIdx: 1});
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.PartyIndexOutOfRange.selector, 0, uint32(2), 2)
        );
        hub.executeRound(0, p, d, badA, new bytes[](2));

        ClearingHubV3.ConsumedRef[] memory badB = new ClearingHubV3.ConsumedRef[](1);
        badB[0] = ClearingHubV3.ConsumedRef({id: keccak256("x"), partyAIdx: 0, partyBIdx: 7});
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.PartyIndexOutOfRange.selector, 0, uint32(7), 2)
        );
        hub.executeRound(0, p, d, badB, new bytes[](2));

        assertEq(hub.roundNonce(), 0, "nonce must not advance");
    }

    /// No IOU has one party. Allowing it would let a single address commit a
    /// leaf unilaterally, which is the CR-01 primitive in miniature.
    function test_revert_executeRound_selfConsumedRef() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = ClearingHubV3.ConsumedRef({id: keccak256("x"), partyAIdx: 1, partyBIdx: 1});
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.SelfConsumedRef.selector, 0));
        hub.executeRound(0, p, d, refs, new bytes[](2));
    }

    /// CR-02: a round that neither moves value nor consumes paper does nothing
    /// but advance the nonce and overwrite a ring slot — rejected, before any
    /// keccak or ecrecover work.
    function test_revert_executeRound_emptyRound() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        vm.expectRevert(ClearingHubV3.EmptyRound.selector);
        hub.executeRound(0, p, new int256[](2), _noRefs(), new bytes[](2));
        assertEq(hub.roundNonce(), 0, "a do-nothing round must never advance the nonce");
    }

    /// ...but an all-cancel round IS legitimate and MUST stay executable: when
    /// every participant's flows cancel exactly, the deltas are all zero and the
    /// manifest is what carries the work. Rejecting this shape would leave
    /// genuinely-cancelled paper redeemable against a stale counterparty, which
    /// is a fairness hole, not a hardening.
    function test_executeRound_allCancelRoundIsLegal() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        _execute(p, new int256[](2), _manifest(p, 2, "all-cancel"));
        assertEq(hub.roundNonce(), 1, "all-cancel round must execute");
        assertEq(hub.collateral(actors[0]), 0, "no value moved");
        assertEq(hub.collateral(actors[1]), 0, "no value moved");
    }

    /// A round with real deltas and an empty manifest stays legal too — it
    /// moves value, so it is not the free-round primitive.
    function test_executeRound_emptyManifestWithRealDeltasIsLegal() public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        (d[0], d[1]) = (int256(-1e6), int256(1e6));
        _execute(p, d, _noRefs());
        assertEq(hub.roundNonce(), 1, "value-moving round must execute");
        assertEq(hub.collateral(actors[1]), 1e6);
    }

    // ------------------------------------------ V3 round-path revert matrix
    //
    // Ported wholesale from ClearingHubV2.t.sol: every guard asserted below was
    // shown deletable-with-the-suite-green against V2 (D-CR-01), so each one is
    // re-pinned here rather than assumed to survive the V3 edit.

    /// The load-bearing one. `src/round.ts`'s verifyProposal deliberately checks
    /// only the CALLER's own delta, so a legitimate participant can inflate
    /// their own delta, leave every other delta correct, and every honest
    /// member's local recomputation still passes and signs. This on-chain check
    /// is the SOLE defense against collateral minting.
    function test_revert_executeRound_deltasDoNotSumToZero_V3() public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        (d[0], d[1]) = (int256(-1e6), int256(9e6)); // sum = +8e6
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 2, "nonzero-sum");
        bytes[] memory sigs = _buildSignatures(0, p, d, refs);

        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.DeltasDoNotSumToZero.selector, int256(8e6))
        );
        hub.executeRound(0, p, d, refs, sigs);

        assertEq(hub.roundNonce(), 0, "nonce must not advance");
        assertEq(
            hub.collateral(actors[0]) + hub.collateral(actors[1]),
            usdc.balanceOf(address(hub)),
            "collateral claims must never exceed the hub's token balance"
        );
    }

    /// With TooFewParticipants gone, `participants.length == 0` skips the
    /// signature loop entirely, so anyone could advance `roundNonce` with an
    /// unsigned round. Both sides of the `< 2` boundary are asserted so a `< 1`
    /// weakening also fails.
    function test_revert_executeRound_tooFewParticipants_V3() public {
        vm.expectRevert(ClearingHubV3.TooFewParticipants.selector);
        hub.executeRound(0, new address[](0), new int256[](0), _noRefs(), new bytes[](0));

        address[] memory one = new address[](1);
        one[0] = actors[0];
        vm.expectRevert(ClearingHubV3.TooFewParticipants.selector);
        hub.executeRound(0, one, new int256[](1), _noRefs(), new bytes[](1));

        assertEq(hub.roundNonce(), 0, "an unsigned round must never advance the nonce");
    }

    /// Canonical participant order is what makes "one signature per member"
    /// mean what it says: a duplicate would let one member's single consent
    /// stand in for two slots — and under V3 it would also let one address
    /// stand in for BOTH parties of a consumed ref.
    function test_revert_executeRound_participantsNotStrictlyAscending_V3() public {
        int256[] memory d = new int256[](2);

        address[] memory dup = new address[](2);
        (dup[0], dup[1]) = (actors[1], actors[1]);
        ClearingHubV3.ConsumedRef[] memory dupRefs = _manifest(dup, 2, "ordering");
        // Signatures are assembled BEFORE expectRevert: _buildSignatures reads
        // hub.hashRound, and that external call would otherwise consume the cheat.
        bytes[] memory dupSigs = _buildSignatures(0, dup, d, dupRefs);
        vm.expectRevert(ClearingHubV3.ParticipantsNotStrictlyAscending.selector);
        hub.executeRound(0, dup, d, dupRefs, dupSigs);

        address[] memory desc = new address[](2);
        (desc[0], desc[1]) = (actors[1], actors[0]);
        ClearingHubV3.ConsumedRef[] memory descRefs = _manifest(desc, 2, "ordering");
        bytes[] memory descSigs = _buildSignatures(0, desc, d, descRefs);
        vm.expectRevert(ClearingHubV3.ParticipantsNotStrictlyAscending.selector);
        hub.executeRound(0, desc, d, descRefs, descSigs);

        assertEq(hub.roundNonce(), 0, "nonce must not advance");
    }

    /// Lower severity — 0.8.x bounds checks already revert on ragged arrays —
    /// but the explicit error is what an integrator debugs against, and it is
    /// the only check covering BOTH trailing arrays.
    function test_revert_executeRound_lengthMismatch_V3() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 2, "length-mismatch");

        vm.expectRevert(ClearingHubV3.LengthMismatch.selector);
        hub.executeRound(0, p, new int256[](1), refs, new bytes[](2)); // deltas short

        vm.expectRevert(ClearingHubV3.LengthMismatch.selector);
        hub.executeRound(0, p, new int256[](2), refs, new bytes[](1)); // signatures short

        assertEq(hub.roundNonce(), 0, "nonce must not advance");
    }

    function test_revert_executeRound_wrongNonce_V3() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.WrongRoundNonce.selector, 0, 7));
        hub.executeRound(7, p, new int256[](2), _noRefs(), new bytes[](2));
    }

    function test_revert_executeRound_badSignature_V3() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 2, "bad-sig");
        bytes[] memory sigs = _buildSignatures(0, p, d, refs);
        // participants[1]'s slot signed by a different key
        sigs[1] = _signRound(keys[2], 0, p, d, _leaves(p, refs));
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.BadSignature.selector, 1));
        hub.executeRound(0, p, d, refs, sigs);
    }

    function test_revert_executeRound_insufficientCollateral_V3() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        (d[0], d[1]) = (int256(-1e6), int256(1e6));
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 1, "no-collateral");
        bytes[] memory sigs = _buildSignatures(0, p, d, refs);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.InsufficientCollateral.selector, actors[0], 0, 1e6
            )
        );
        hub.executeRound(0, p, d, refs, sigs);
    }

    // ------------------------------------------- deposit/withdraw/constructor

    function test_revert_deposit_zeroAmount_V3() public {
        vm.prank(actors[0]);
        vm.expectRevert(ClearingHubV3.ZeroAmount.selector);
        hub.deposit(0);
        assertEq(hub.collateral(actors[0]), 0, "no phantom deposit");
    }

    function test_revert_withdraw_overBalance_V3() public {
        _fundAndDeposit(actors[0], 10e6);

        vm.prank(actors[0]);
        vm.expectRevert(ClearingHubV3.InsufficientWithdrawBalance.selector);
        hub.withdraw(10e6 + 1);

        vm.prank(actors[0]);
        vm.expectRevert(ClearingHubV3.ZeroAmount.selector);
        hub.withdraw(0);

        assertEq(hub.collateral(actors[0]), 10e6, "balance untouched by refused exits");
        assertEq(usdc.balanceOf(actors[0]), 0, "no tokens left the hub");
    }

    /// K/RING/MAX_IOU_LIFETIME are immutable, so a bad deploy is unfixable:
    /// RING == 0 makes `rootRing[nonce_ % RING]` a division-by-zero panic on
    /// the very first round (bricking the hub), K == 0 makes every debtor
    /// instantly redeemable-against, and L == 0 makes the coverage window
    /// unsatisfiable. Each argument is asserted independently.
    function test_revert_constructor_badConfig() public {
        vm.expectRevert(ClearingHubV3.BadConfig.selector);
        new ClearingHubV3(usdc, 0, RING, L);

        vm.expectRevert(ClearingHubV3.BadConfig.selector);
        new ClearingHubV3(usdc, K, 0, L);

        vm.expectRevert(ClearingHubV3.BadConfig.selector);
        new ClearingHubV3(usdc, K, RING, 0);
    }

    // ---------------------------------------------------------- WR-06: owner

    /// `Ownable2Step` overrides transferOwnership but NOT renounceOwnership.
    /// Renouncing while paused would make `unpause` unreachable forever, so V3
    /// removes the function rather than relying on ops discipline.
    function test_revert_renounceOwnership_disabled() public {
        vm.expectRevert(ClearingHubV3.RenounceDisabled.selector);
        hub.renounceOwnership();
        assertEq(hub.owner(), address(this), "owner unchanged");
    }

    /// The escape hatch WR-05 actually wants stays open: ownership can still be
    /// handed to a multisig/timelock through the two-step transfer.
    function test_transferOwnership_stillWorks() public {
        hub.transferOwnership(actors[0]);
        vm.prank(actors[0]);
        hub.acceptOwnership();
        assertEq(hub.owner(), actors[0], "two-step transfer must still work");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        hub.pause();
    }

    // ------------------------------------------------- redeemIOU happy path

    function test_redeemIOU_debitsStaleDebtor() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        uint256 hubBalanceBefore = usdc.balanceOf(address(hub));

        vm.expectEmit(true, true, true, true);
        emit ClearingHubV3.IouRedeemed(id, actors[0], actors[1], 5e6, 3);
        hub.redeemIOU(iou, sig, _proofsForIou(iou));

        assertEq(hub.collateral(actors[0]), 5e6, "debtor debited exactly amount");
        assertEq(hub.collateral(actors[1]), 5e6, "creditor credited exactly amount");
        // Collateral conservation: redemption moves collateral, never tokens.
        assertEq(usdc.balanceOf(address(hub)), hubBalanceBefore, "hub balance not conserved");
        assertTrue(hub.redeemed(id), "nullifier set");
    }

    // --------------------------------------------------------- revert matrix

    function test_revert_redeemIOU_notStale() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        // Debtor participates in round 0, then misses only 2 of the 3 required.
        _executeRoundWithout(address(0)); // all five actors
        _executeRoundWithout(actors[0]);
        _executeRoundWithout(actors[0]);
        // roundNonce=3, lastRound[debtor]=1: 3 - 1 == 2 < K
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.DebtorNotStale.selector, 1, 3));
        hub.redeemIOU(iou, sig, proofs);
    }

    /// Never-participated debtor (lastRound == 0): stale iff roundNonce >= K.
    /// Both sides of the boundary (Pitfall 6).
    function test_revert_redeemIOU_neverParticipatedBoundary() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);

        _executeRoundWithout(actors[0]);
        _executeRoundWithout(actors[0]);
        // roundNonce == K-1 == 2: not yet stale
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.DebtorNotStale.selector, 0, 3));
        hub.redeemIOU(iou, sig, proofs);

        _executeRoundWithout(actors[0]);
        // roundNonce == K == 3: ignored every round that ever existed — stale
        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        assertEq(hub.collateral(actors[0]), 5e6);
        assertEq(hub.collateral(actors[1]), 5e6);
    }

    /// Eviction occurred (roundNonce > RING) and the oldest buffered root does
    /// NOT predate expiry - L: a consuming round may be unverifiable — revert.
    function test_revert_redeemIOU_coverageNotBuffered() public {
        _fundAndDeposit(actors[0], 10e6);
        // Signed at t=1 with the L-convention max: expiry = 1 + L.
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 i; i < 17; ++i) {
            _executeRoundWithout(actors[0]); // RING+1 rounds: round 0 evicted
        }
        // oldest buffered round (nonce 1) executedAt=1 >= windowStart=1
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.CoverageWindowNotBuffered.selector, uint64(1), uint64(1)
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    /// expiry <= L with evicted history: the would-be underflow branch is
    /// fail-closed and reports windowStart 0 (the honest floor).
    function test_revert_redeemIOU_coverageExpiryUnderflow() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1, 100); // expiry <= L
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 i; i < 17; ++i) {
            _executeRoundWithout(actors[0]);
        }
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.CoverageWindowNotBuffered.selector, uint64(1), uint64(0)
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    /// Positive coverage after eviction: the oldest buffered root predates
    /// expiry - L, so every possible consuming round is still buffered.
    function test_redeemIOU_afterEviction_coverageWindowClear() public {
        _fundAndDeposit(actors[0], 10e6);
        for (uint256 i; i < 17; ++i) {
            _executeRoundWithout(actors[0]); // all executed at t=1
        }
        vm.warp(200000);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1); // expiry = 200000 + L
        bytes memory sig = _signIou(keys[0], iou);
        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        assertEq(hub.collateral(actors[1]), 5e6);
    }

    function test_revert_redeemIOU_badSignature() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[2], iou); // signer is not the debtor
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(ClearingHubV3.BadIouSignature.selector);
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_revert_redeemIOU_alreadyRedeemed() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.AlreadyRedeemed.selector, id));
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_revert_redeemIOU_proofCountMismatch() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetup();
        ManifestMerkle.NonInclusionProof[] memory full = _proofsForIou(iou);
        assertEq(full.length, 3, "test-internal: expected 3 buffered rounds");
        ManifestMerkle.NonInclusionProof[] memory short_ =
            new ManifestMerkle.NonInclusionProof[](2);
        (short_[0], short_[1]) = (full[0], full[1]); // drop one proof
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.ProofCountMismatch.selector, 3, 2));
        hub.redeemIOU(iou, sig, short_);
    }

    /// Exclusivity, structural net->cannot-redeem direction (MERK-04/D-15): an
    /// IOU consumed in a buffered round can never yield a valid non-inclusion
    /// proof for that round — strict inequalities make it impossible.
    ///
    /// Under V3 the consuming round must contain BOTH parties (they both sign),
    /// so this models the only way an IOU can legitimately be netted.
    function test_revert_redeemIOU_nonInclusionInvalid() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        bytes32 id = hub.hashIou(iou);

        // Round 0: all five actors consent, and the manifest genuinely consumes
        // the IOU (plus two neighbors so the bracketing proof is a real one).
        address[] memory p = _presentActors(address(0));
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 3, "neighbors");
        refs[0] = _refFor(p, id, iou.debtor, iou.creditor);
        _sortRefs(p, refs);
        _execute(p, new int256[](p.length), refs);

        // Rounds 1..3 without the debtor — now stale (4 - 1 == 3 == K).
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }

        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.NonInclusionProofInvalid.selector, uint64(0))
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    /// Withdraw-race honesty (Pitfall 2): redemption recovers posted,
    /// still-present collateral only — a debtor who exits first leaves nothing.
    function test_revert_redeemIOU_insufficientCollateral() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetup();
        vm.prank(actors[0]);
        hub.withdraw(10e6); // never-pausable exit front-runs redemption
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.InsufficientCollateral.selector, actors[0], 0, 5e6
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_revert_redeemIOU_zeroAmount() public {
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 0, 1);
        vm.expectRevert(ClearingHubV3.ZeroAmount.selector);
        hub.redeemIOU(iou, "", new ManifestMerkle.NonInclusionProof[](0));
    }

    function test_revert_redeemIOU_selfIou() public {
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[0], 5e6, 1);
        vm.expectRevert(ClearingHubV3.SelfIou.selector);
        hub.redeemIOU(iou, "", new ManifestMerkle.NonInclusionProof[](0));
    }

    /// IN-04: crediting the zero address would permanently burn the debtor's
    /// collateral. Self-harm only (the debtor signs), but free to refuse.
    function test_revert_redeemIOU_zeroAddressParty() public {
        ClearingHubV3.Iou memory a = _makeIou(actors[0], address(0), 5e6, 1);
        vm.expectRevert(ClearingHubV3.ZeroAddressParty.selector);
        hub.redeemIOU(a, "", new ManifestMerkle.NonInclusionProof[](0));

        ClearingHubV3.Iou memory b = _makeIou(address(0), actors[1], 5e6, 1);
        vm.expectRevert(ClearingHubV3.ZeroAddressParty.selector);
        hub.redeemIOU(b, "", new ManifestMerkle.NonInclusionProof[](0));
    }

    /// WR-01: ManifestMerkle's width recurrence `w = (w + 1) >> 1` panics
    /// (checked-arithmetic 0x11) on a leafCount near 2^256, which under V2
    /// surfaced as an opaque Panic instead of a proof error. V3 bounds it first.
    function test_revert_redeemIOU_implausibleLeafCount() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetup();
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        proofs[0].a.leafCount = type(uint256).max;
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.ImplausibleLeafCount.selector, type(uint256).max
            )
        );
        hub.redeemIOU(iou, sig, proofs);
    }

    // -------------------------------------------------------- pause boundary

    function test_redeemIOU_revertsWhilePaused() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetup();
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        hub.pause();
        vm.expectRevert();
        hub.redeemIOU(iou, sig, proofs);
    }

    function test_executeRound_revertsWhilePaused_V3() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 1, "paused");
        bytes[] memory sigs = _buildSignatures(0, p, new int256[](2), refs);
        hub.pause();
        vm.expectRevert();
        hub.executeRound(0, p, new int256[](2), refs, sigs);
    }

    function test_withdraw_worksWhilePaused_V3() public {
        _fundAndDeposit(actors[0], 10e6);
        hub.pause();
        vm.prank(actors[0]);
        hub.withdraw(10e6); // exit must never be pausable (D-12)
        assertEq(usdc.balanceOf(actors[0]), 10e6);
    }

    // ------------------------------------------------------------------ fuzz

    /// Stale setup where every buffered round carries a distinct 3-entry
    /// manifest, so no proof is a sentinel short-circuit and positional
    /// mismatches are always detectable.
    function _staleSetupWithManifests()
        internal
        returns (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id)
    {
        _fundAndDeposit(actors[0], 10e6);
        iou = _makeIou(actors[0], actors[1], 5e6, 1);
        sig = _signIou(keys[0], iou);
        id = hub.hashIou(iou);
        for (uint256 r; r < K; ++r) {
            _executeRoundWithout(actors[0], 3);
        }
    }

    /// T-02-21: a fuzz-chosen proof removed (count mismatch) or two proofs
    /// swapped (positional mismatch) always reverts, state untouched.
    function testFuzz_redeemProofSetSkip_reverts(uint256 seed) public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetupWithManifests();
        ManifestMerkle.NonInclusionProof[] memory full = _proofsForIou(iou);
        uint256 debtorBefore = hub.collateral(actors[0]);
        uint256 creditorBefore = hub.collateral(actors[1]);

        if (seed % 2 == 0) {
            uint256 drop = (seed >> 8) % 3;
            ManifestMerkle.NonInclusionProof[] memory bad =
                new ManifestMerkle.NonInclusionProof[](2);
            uint256 j;
            for (uint256 i; i < 3; ++i) {
                if (i != drop) bad[j++] = full[i];
            }
            vm.expectRevert(
                abi.encodeWithSelector(ClearingHubV3.ProofCountMismatch.selector, 3, 2)
            );
            hub.redeemIOU(iou, sig, bad);
        } else {
            uint256 i_ = seed % 3;
            uint256 j_ = (i_ + 1 + ((seed >> 8) % 2)) % 3;
            (full[i_], full[j_]) = (full[j_], full[i_]);
            vm.expectRevert(); // NonInclusionProofInvalid at first mismatched nonce
            hub.redeemIOU(iou, sig, full);
        }

        assertEq(hub.roundNonce(), 3, "state must be untouched");
        assertEq(hub.collateral(actors[0]), debtorBefore, "debtor balance moved");
        assertEq(hub.collateral(actors[1]), creditorBefore, "creditor balance moved");
    }

    /// T-02-22: after one successful redemption, fuzz-perturbed re-attempts
    /// always revert AlreadyRedeemed (nullifier precedes proof checks) and
    /// balances never move again.
    function testFuzz_redeemNullifierIdempotent(uint256 seed) public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetupWithManifests();
        hub.redeemIOU(iou, sig, _proofsForIou(iou));
        uint256 debtorAfter = hub.collateral(actors[0]);
        uint256 creditorAfter = hub.collateral(actors[1]);

        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        uint256 mode = seed % 3;
        if (mode == 1) {
            proofs = new ManifestMerkle.NonInclusionProof[]((seed >> 8) % 3); // wrong count
        } else if (mode == 2) {
            proofs[(seed >> 8) % 3].a.leaf = bytes32(seed); // garbage contents
        } // mode 0: byte-identical replay

        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.AlreadyRedeemed.selector, id));
        hub.redeemIOU(iou, sig, proofs);

        assertEq(hub.collateral(actors[0]), debtorAfter, "debtor balance moved again");
        assertEq(hub.collateral(actors[1]), creditorAfter, "creditor balance moved again");
        assertTrue(hub.redeemed(id), "nullifier must stay set");
    }

    /// T-02-21: perturbing index / leafCount / one sibling of a fuzz-chosen
    /// proof in an otherwise-valid set always reverts at that proof's nonce.
    function testFuzz_redeemProofPerturbation_reverts(uint256 seed) public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetupWithManifests();
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);
        uint256 debtorBefore = hub.collateral(actors[0]);
        uint256 creditorBefore = hub.collateral(actors[1]);

        uint256 k = seed % 3;
        uint256 mode = (seed >> 8) % 3;
        if (mode == 0) {
            proofs[k].a.index += 1; // breaks kind-position binding / adjacency
        } else if (mode == 1) {
            // 3 -> 8 leaves: the full-tree schedule demands 3 siblings, the
            // proof carries at most 2 — schedule mismatch, never verifies
            proofs[k].a.leafCount += 5;
        } else {
            uint256 sc = proofs[k].a.siblings.length;
            uint256 si = (seed >> 16) % sc;
            proofs[k].a.siblings[si] =
                proofs[k].a.siblings[si] ^ bytes32(uint256(1) << ((seed >> 24) % 256));
        }

        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.NonInclusionProofInvalid.selector, uint64(k))
        );
        hub.redeemIOU(iou, sig, proofs);

        assertEq(hub.roundNonce(), 3, "state must be untouched");
        assertEq(hub.collateral(actors[0]), debtorBefore, "debtor balance moved");
        assertEq(hub.collateral(actors[1]), creditorBefore, "creditor balance moved");
    }

    /// Zero-sum is enforced for every fuzz-chosen perturbation of a valid,
    /// fully-signed round: mutating one delta changes the digest, so the round
    /// dies at BadSignature; re-signing the mutation dies at the sum check.
    function testFuzz_perturbedDeltaAlwaysReverts(int256 delta, uint256 which) public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](3);
        int256[] memory d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        (d[0], d[1], d[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 2, "fuzz-sum");

        uint256 i = which % 3;
        delta = int256(bound(delta, -1e12, 1e12));
        if (delta == d[i]) return; // not a perturbation
        d[i] = delta;

        bytes[] memory sigs = _buildSignatures(0, p, d, refs); // re-signed mutation
        int256 sum = d[0] + d[1] + d[2];
        if (sum != 0) {
            vm.expectRevert(
                abi.encodeWithSelector(ClearingHubV3.DeltasDoNotSumToZero.selector, sum)
            );
            hub.executeRound(0, p, d, refs, sigs);
            assertEq(hub.roundNonce(), 0, "nonce must not advance");
        }
        assertEq(
            hub.collateral(actors[0]) + hub.collateral(actors[1]) + hub.collateral(actors[2]),
            usdc.balanceOf(address(hub)),
            "collateral claims must never exceed the hub's token balance"
        );
    }

    // ------------------------------------------------------------------- gas
    //
    // Historical m-series at a hard-coded n=5, kept for continuity with
    // ClearingHubV2.t.sol so the V2->V3 delta is directly comparable.
    // GasScalingV3.t.sol is the file that measures across n AND includes
    // intrinsic gas.

    function _gasExecuteRound(uint256 m) internal returns (uint256 used) {
        address[] memory p = new address[](5);
        int256[] memory d = new int256[](5);
        for (uint256 i; i < 5; ++i) {
            p[i] = actors[i];
        }
        (d[0], d[1], d[2], d[3], d[4]) =
            (int256(-3e6), int256(1e6), int256(2e6), int256(-1e6), int256(1e6));
        _fundAndDeposit(actors[0], 10e6);
        _fundAndDeposit(actors[3], 10e6);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, m, "gas-manifest");
        bytes[] memory sigs = _buildSignatures(0, p, d, refs);

        uint256 g0 = gasleft();
        hub.executeRound(0, p, d, refs, sigs);
        used = g0 - gasleft();
        assertEq(hub.roundNonce(), 1, "round must have executed");
    }

    function test_gas_executeRound_m10() public {
        console2.log("V3 gas_executeRound n=5 m=10:", _gasExecuteRound(10));
    }

    function test_gas_executeRound_m105() public {
        console2.log("V3 gas_executeRound n=5 m=105:", _gasExecuteRound(105));
    }

    function test_gas_executeRound_m250() public {
        console2.log("V3 gas_executeRound n=5 m=250:", _gasExecuteRound(250));
    }

    /// redeemIOU with the full RING=16 populated: 16 real (non-sentinel)
    /// non-inclusion proofs over 8-entry manifests.
    function test_gas_redeemIOU_ring16() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 r; r < 16; ++r) {
            _executeRoundWithout(actors[0], 8);
        }
        ManifestMerkle.NonInclusionProof[] memory proofs = _proofsForIou(iou);

        uint256 g0 = gasleft();
        hub.redeemIOU(iou, sig, proofs);
        uint256 used = g0 - gasleft();
        console2.log("V3 gas_redeemIOU RING=16 (8-entry manifests):", used);
        assertEq(hub.collateral(actors[1]), 5e6, "redemption must have settled");
    }
}
