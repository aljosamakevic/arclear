// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RoundBuilderV3} from "./utils/RoundBuilderV3.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";
import {ManifestMerkle} from "../src/lib/ManifestMerkle.sol";

/// @title  ClearingHubV3 — full port of the V2 suite plus the V3-only surface
/// @notice Every assertion ClearingHubV2.t.sol made is reproduced here against
///         V3, EXCEPT those that pinned the root ring, the `expiry - L` coverage
///         precondition and the non-inclusion proof regime — that whole
///         mechanism was deleted, not weakened, and is replaced by the
///         `consumed` ledger assertions below. The attack proofs live in
///         ClearingHubV3PoC.t.sol.
contract ClearingHubV3Test is RoundBuilderV3 {
    function setUp() public {
        _setUpActors();
    }

    /// Fund the debtor (actors[0]), sign an IOU to actors[1], then stale the
    /// debtor on the ON-CHAIN clock: K executed rounds in which they settle
    /// nothing (Pitfall 4 — never coordinator counters).
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
    /// coordinator that lists (creditor, debtor) writes the SAME ledger key the
    /// creditor's redemption later reads, so a genuinely-netted IOU can never
    /// stay redeemable through an argument-order slip.
    function test_manifestLeafId_isPairOrderInsensitive() public view {
        bytes32 id = keccak256("some-iou");
        assertEq(
            hub.manifestLeafId(id, actors[0], actors[1]),
            hub.manifestLeafId(id, actors[1], actors[0]),
            "leaf must not depend on party argument order"
        );
    }

    /// Different party pairs over the SAME id derive different keys. This is
    /// the whole of the CR-01 fix, and the reason the CR-02 ledger can be keyed
    /// on the leaf without re-opening CR-01.
    function test_manifestLeafId_differsAcrossPartyPairs() public view {
        bytes32 id = keccak256("some-iou");
        assertTrue(
            hub.manifestLeafId(id, actors[0], actors[1])
                != hub.manifestLeafId(id, actors[3], actors[4]),
            "an unrelated pair must not be able to write the honest ledger key"
        );
    }

    // ------------------------------------------------- executeRound evolution

    /// The manifest commitment is KEPT: the root still travels into the signed
    /// digest, so signatures bind the exact leaf set even though redemption no
    /// longer proves anything against it.
    function test_executeRound_manifestRootStillBindsTheDigest() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d, ClearingHubV3.ConsumedRef[] memory refs) =
            _simpleRound();
        bytes32 root = ManifestMerkle.rootOf(_leaves(p, refs));

        vm.expectEmit(true, true, true, true);
        emit ClearingHubV3.RoundExecuted(0, hub.hashRound(0, p, d, root), root, 3, 3e6);
        _execute(p, d, refs);
    }

    /// Every consumed leaf lands in the permanent ledger.
    function test_executeRound_writesConsumedLedger() public {
        _fundAndDeposit(actors[0], 10e6);
        (address[] memory p, int256[] memory d, ClearingHubV3.ConsumedRef[] memory refs) =
            _simpleRound();
        _execute(p, d, refs);

        bytes32[] memory leaves = _leaves(p, refs);
        for (uint256 i; i < leaves.length; ++i) {
            assertTrue(hub.consumed(leaves[i]), "leaf missing from consumption ledger");
        }
        assertFalse(hub.consumed(keccak256("never-netted")), "unrelated key must stay clear");
    }

    /// WR-11: `lastRound` refreshes for participants who settled something —
    /// a non-zero delta OR a ref naming them — and NOT for a pure co-signer.
    /// V2 refreshed everyone, which is what made a keep-alive round free.
    function test_executeRound_lastRoundOnlyForSettlingParticipants() public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](3);
        int256[] memory d = new int256[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        // actors[1] gets a zero delta AND no attributed ref: a pure co-signer.
        (d[0], d[1], d[2]) = (int256(-1e6), int256(0), int256(1e6));
        _execute(p, d, _manifest(p, 2, "wr11", 0, 2));

        assertEq(hub.lastRound(actors[0]), 1, "attributed + non-zero delta");
        assertEq(hub.lastRound(actors[2]), 1, "attributed + non-zero delta");
        assertEq(hub.lastRound(actors[1]), 0, "pure co-signer must NOT refresh (WR-11)");
        assertEq(hub.lastRound(actors[3]), 0, "non-participant untouched");
    }

    /// The delta disjunct is load-bearing: a round may legitimately move value
    /// with an empty manifest, and those participants must not be recorded idle.
    function test_executeRound_lastRoundRefreshesOnDeltaAlone() public {
        _fundAndDeposit(actors[0], 10e6);
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        (d[0], d[1]) = (int256(-1e6), int256(1e6));
        _execute(p, d, _noRefs());
        assertEq(hub.lastRound(actors[0]), 1, "value-moving participant must refresh");
        assertEq(hub.lastRound(actors[1]), 1, "value-moving participant must refresh");
    }

    /// The sorted-manifest guard orders DERIVED LEAVES, not raw ids — the SDK's
    /// sort key changes with it.
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
        hub.redeemIOU(iou, sig);

        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = _refFor(p, id, iou.debtor, iou.creditor);
        uint64 nonce_ = hub.roundNonce();
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.NullifiedIdInManifest.selector, id));
        hub.executeRound(nonce_, p, d, refs, new bytes[](2));
    }

    /// IN-05: "one IOU, one settlement" is now an on-chain invariant rather
    /// than a coordinator convention. Under V2 the same id could appear in
    /// unlimited round manifests.
    function test_revert_executeRound_alreadyConsumedAcrossRounds() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 1, "double-net");
        bytes32 leaf = _leaves(p, refs)[0];

        _execute(p, new int256[](2), refs);
        assertTrue(hub.consumed(leaf), "first round must have consumed it");

        uint64 nonce_ = hub.roundNonce();
        bytes[] memory sigs = _buildSignatures(nonce_, p, new int256[](2), refs);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.AlreadyConsumed.selector, leaf));
        hub.executeRound(nonce_, p, new int256[](2), refs, sigs);
    }

    // ---------------------------------------------------- V3-only round gates

    /// CR-01 input validation: a ref may only name participants of THIS round.
    /// Both indices are checked, and both before any signature work.
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

    /// No IOU has one party. Allowing it would let a single address write a
    /// ledger key unilaterally, which is the CR-01 primitive in miniature.
    function test_revert_executeRound_selfConsumedRef() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        int256[] memory d = new int256[](2);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = ClearingHubV3.ConsumedRef({id: keccak256("x"), partyAIdx: 1, partyBIdx: 1});
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.SelfConsumedRef.selector, 0));
        hub.executeRound(0, p, d, refs, new bytes[](2));
    }

    /// A round that neither moves value nor consumes paper does nothing but
    /// advance `roundNonce`, which drags every non-participant closer to being
    /// redeemable-against. Rejected, before any keccak or ecrecover work.
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
    /// moves value, so it is not the do-nothing shape.
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
        // The ledger write happens before the collateral loop, so this also
        // pins that a reverted round leaves NO ledger residue.
        assertFalse(hub.consumed(_leaves(p, refs)[0]), "reverted round must not consume");
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

    /// K is immutable, so a bad deploy is unfixable: K == 0 makes every debtor
    /// instantly redeemable-against. RING and MAX_IOU_LIFETIME no longer exist,
    /// so the V2 BadConfig matrix collapses to this one argument.
    function test_revert_constructor_badConfig() public {
        vm.expectRevert(ClearingHubV3.BadConfig.selector);
        new ClearingHubV3(usdc, 0);
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
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        hub.pause();
    }

    // ------------------------------------------------- redeemIOU happy path

    function test_redeemIOU_debitsStaleDebtor() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        uint256 hubBalanceBefore = usdc.balanceOf(address(hub));

        vm.expectEmit(true, true, true, true);
        emit ClearingHubV3.IouRedeemed(id, actors[0], actors[1], 5e6, 3);
        hub.redeemIOU(iou, sig);

        assertEq(hub.collateral(actors[0]), 5e6, "debtor debited exactly amount");
        assertEq(hub.collateral(actors[1]), 5e6, "creditor credited exactly amount");
        // Collateral conservation: redemption moves collateral, never tokens.
        assertEq(usdc.balanceOf(address(hub)), hubBalanceBefore, "hub balance not conserved");
        assertTrue(hub.redeemed(id), "nullifier set");
    }

    /// Redemption no longer depends on ANY bounded history. Under V2 this exact
    /// shape (far more than RING rounds executed since the IOU was signed) hit
    /// the `expiry - L` coverage precondition; V3 has no such precondition, so
    /// an old IOU against a stale debtor is still recoverable.
    function test_redeemIOU_afterManyRounds_noCoverageWindow() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 i; i < 40; ++i) {
            _executeRoundWithout(actors[0]);
        }
        vm.warp(block.timestamp + 30 days); // long past expiry: recovery is not netting
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(actors[1]), 5e6, "history depth must not gate redemption");
    }

    /// A short-lived IOU is no harder to redeem than a maximum-dated one
    /// (WR-03 died with the coverage rule, which keyed off `expiry - L`).
    function test_redeemIOU_shortExpiryIsNotPenalised() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou =
            _makeIou(actors[0], actors[1], 5e6, 1, uint64(block.timestamp) + 300);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 i; i < 20; ++i) {
            _executeRoundWithout(actors[0]);
        }
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(actors[1]), 5e6, "short-dated paper must redeem too");
    }

    // --------------------------------------------------------- revert matrix

    function test_revert_redeemIOU_notStale() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        // Debtor settles in round 0, then misses only 2 of the 3 required.
        _executeRoundWithout(address(0)); // all five actors; refs name actors[0]
        _executeRoundWithout(actors[0]);
        _executeRoundWithout(actors[0]);
        // roundNonce=3, lastRound[debtor]=1: 3 - 1 == 2 < K
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.DebtorNotStale.selector, 1, 3));
        hub.redeemIOU(iou, sig);
    }

    /// Never-settled debtor (lastRound == 0): stale iff roundNonce >= K.
    /// Both sides of the boundary (Pitfall 6).
    function test_revert_redeemIOU_neverParticipatedBoundary() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);

        _executeRoundWithout(actors[0]);
        _executeRoundWithout(actors[0]);
        // roundNonce == K-1 == 2: not yet stale
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.DebtorNotStale.selector, 0, 3));
        hub.redeemIOU(iou, sig);

        _executeRoundWithout(actors[0]);
        // roundNonce == K == 3: settled nothing in every round that ever existed
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(actors[0]), 5e6);
        assertEq(hub.collateral(actors[1]), 5e6);
    }

    function test_revert_redeemIOU_badSignature() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[2], iou); // signer is not the debtor
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }
        vm.expectRevert(ClearingHubV3.BadIouSignature.selector);
        hub.redeemIOU(iou, sig);
    }

    function test_revert_redeemIOU_alreadyRedeemed() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        hub.redeemIOU(iou, sig);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.AlreadyRedeemed.selector, id));
        hub.redeemIOU(iou, sig);
    }

    /// Exclusivity, net->cannot-redeem direction (D-14/D-15), now a single
    /// permanent ledger read instead of a proof set over a bounded ring. Under
    /// V3 the consuming round must contain BOTH parties (they both sign), so
    /// this models the only way an IOU can be netted at all.
    function test_revert_redeemIOU_alreadyNetted() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        bytes32 id = hub.hashIou(iou);

        address[] memory p = new address[](2);
        (p[0], p[1]) = (actors[0], actors[1]);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = _refFor(p, id, iou.debtor, iou.creditor);
        _execute(p, new int256[](2), refs); // an all-cancel round, both consenting

        assertTrue(hub.isConsumed(iou), "isConsumed view must agree with the ledger");

        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }

        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.IouAlreadyNetted.selector, _leafOf(iou))
        );
        hub.redeemIOU(iou, sig);
    }

    /// Withdraw-race honesty (Pitfall 2): redemption recovers posted,
    /// still-present collateral only — a debtor who exits first leaves nothing.
    function test_revert_redeemIOU_insufficientCollateral() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetup();
        vm.prank(actors[0]);
        hub.withdraw(10e6); // never-pausable exit front-runs redemption
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.InsufficientCollateral.selector, actors[0], 0, 5e6
            )
        );
        hub.redeemIOU(iou, sig);
    }

    function test_revert_redeemIOU_zeroAmount() public {
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 0, 1);
        vm.expectRevert(ClearingHubV3.ZeroAmount.selector);
        hub.redeemIOU(iou, "");
    }

    function test_revert_redeemIOU_selfIou() public {
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[0], 5e6, 1);
        vm.expectRevert(ClearingHubV3.SelfIou.selector);
        hub.redeemIOU(iou, "");
    }

    /// IN-04: crediting the zero address would permanently burn the debtor's
    /// collateral. Self-harm only (the debtor signs), but free to refuse.
    function test_revert_redeemIOU_zeroAddressParty() public {
        ClearingHubV3.Iou memory a = _makeIou(actors[0], address(0), 5e6, 1);
        vm.expectRevert(ClearingHubV3.ZeroAddressParty.selector);
        hub.redeemIOU(a, "");

        ClearingHubV3.Iou memory b = _makeIou(address(0), actors[1], 5e6, 1);
        vm.expectRevert(ClearingHubV3.ZeroAddressParty.selector);
        hub.redeemIOU(b, "");
    }

    // -------------------------------------------------------- pause boundary

    function test_redeemIOU_revertsWhilePaused() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _staleSetup();
        hub.pause();
        vm.expectRevert();
        hub.redeemIOU(iou, sig);
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

    /// Zero-sum is enforced for every fuzz-chosen perturbation of a valid,
    /// fully-signed round: re-signing the mutation still dies at the sum check,
    /// and no ledger entry survives the revert.
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
            assertFalse(hub.consumed(_leaves(p, refs)[0]), "reverted round must not consume");
        }
        assertEq(
            hub.collateral(actors[0]) + hub.collateral(actors[1]) + hub.collateral(actors[2]),
            usdc.balanceOf(address(hub)),
            "collateral claims must never exceed the hub's token balance"
        );
    }

    /// CR-01 as a property: NO pairing an attacker can write ever blocks the
    /// honest redemption, for any fuzz-chosen attacker pair drawn from the
    /// actors who are not party to the IOU.
    function testFuzz_poisonedPairNeverBlocksRedemption(uint256 seed) public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();

        // Two distinct attackers from {actors[2], actors[3], actors[4]}.
        uint256 ai = seed % 3;
        uint256 bi = (seed >> 8) % 3;
        if (ai == bi) bi = (bi + 1) % 3;
        address x = actors[2 + ai];
        address y = actors[2 + bi];
        address[] memory p = new address[](2);
        (p[0], p[1]) = x < y ? (x, y) : (y, x);

        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = ClearingHubV3.ConsumedRef({id: id, partyAIdx: 0, partyBIdx: 1});
        _execute(p, new int256[](2), refs);

        assertFalse(hub.isConsumed(iou), "the honest ledger key must stay clear");
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(actors[1]), 5e6, "poisoning must never block redemption");
    }

    /// Exclusivity as a property: for any fuzz-chosen IOU, consuming it in a
    /// round makes redemption impossible, and NOT consuming it leaves
    /// redemption available. The two directions are mutually exclusive and
    /// jointly exhaustive.
    function testFuzz_consumedIffNotRedeemable(uint256 amount, uint256 nonce, bool consume)
        public
    {
        amount = bound(amount, 1, 5e6);
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], amount, nonce);
        bytes memory sig = _signIou(keys[0], iou);

        if (consume) {
            address[] memory p = new address[](2);
            (p[0], p[1]) = (actors[0], actors[1]);
            ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
            refs[0] = _refFor(p, hub.hashIou(iou), iou.debtor, iou.creditor);
            _execute(p, new int256[](2), refs);
        }
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(actors[0]);
        }

        if (consume) {
            vm.expectRevert(
                abi.encodeWithSelector(ClearingHubV3.IouAlreadyNetted.selector, _leafOf(iou))
            );
            hub.redeemIOU(iou, sig);
            assertEq(hub.collateral(actors[1]), 0, "netted paper must not also pay out");
        } else {
            hub.redeemIOU(iou, sig);
            assertEq(hub.collateral(actors[1]), amount, "unnetted paper must be recoverable");
        }
    }

    /// After one successful redemption, fuzz-perturbed re-attempts always
    /// revert and balances never move again.
    function testFuzz_redeemNullifierIdempotent(uint256 seed) public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _staleSetup();
        hub.redeemIOU(iou, sig);
        uint256 debtorAfter = hub.collateral(actors[0]);
        uint256 creditorAfter = hub.collateral(actors[1]);

        for (uint256 r; r < seed % 4; ++r) {
            _executeRoundWithout(actors[0]); // more history changes nothing
        }
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.AlreadyRedeemed.selector, id));
        hub.redeemIOU(iou, sig);

        assertEq(hub.collateral(actors[0]), debtorAfter, "debtor balance moved again");
        assertEq(hub.collateral(actors[1]), creditorAfter, "creditor balance moved again");
        assertTrue(hub.redeemed(id), "nullifier must stay set");
    }

    // ------------------------------------------------------------------- gas
    //
    // Historical m-series at a hard-coded n=5, kept for continuity with
    // ClearingHubV2.t.sol so the V2->V3 delta is directly comparable.
    // GasScalingV3.t.sol measures across n AND includes intrinsic gas.

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

    /// redeemIOU is now O(1): no proofs, no ring walk. The V2 counterpart with
    /// RING=16 populated cost 199,604.
    function test_gas_redeemIOU_ledger() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 r; r < 16; ++r) {
            _executeRoundWithout(actors[0], 8);
        }

        uint256 g0 = gasleft();
        hub.redeemIOU(iou, sig);
        uint256 used = g0 - gasleft();
        console2.log("V3 gas_redeemIOU (ledger, O(1)):", used);
        assertEq(hub.collateral(actors[1]), 5e6, "redemption must have settled");
    }

    /// ...and it stays O(1) as history grows, which is the property the ring
    /// could not offer. Same measurement after 4x the round count.
    function test_gas_redeemIOU_ledgerIsHistoryIndependent() public {
        _fundAndDeposit(actors[0], 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(actors[0], actors[1], 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        for (uint256 r; r < 64; ++r) {
            _executeRoundWithout(actors[0], 8);
        }

        uint256 g0 = gasleft();
        hub.redeemIOU(iou, sig);
        uint256 used = g0 - gasleft();
        console2.log("V3 gas_redeemIOU after 64 rounds:", used);
        assertEq(hub.collateral(actors[1]), 5e6, "redemption must have settled");
    }
}
