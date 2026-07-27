// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {RoundBuilderV3} from "./utils/RoundBuilderV3.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";

/// @title  Audit PoCs re-run against ClearingHubV3
/// @notice Direct ports of the 2026-07-27 audit's CR-01, CR-02 and WR-11
///         proofs-of-concept (`.planning/audits/2026-07-27-full-audit/A-contracts.md`).
///         Against ClearingHubV2 every one of these attacks SUCCEEDED.
///
///         CR-01 is closed by the party-bound manifest leaf. CR-02 is closed by
///         REMOVAL: the root ring, the `expiry - L` coverage precondition and
///         the non-inclusion proof regime the attack targeted no longer exist,
///         replaced by a permanent consumption ledger. There is nothing left to
///         flush, so `test_poc2` asserts the absence of the attack surface
///         rather than a raised price.
///
///         `test_poc5b` remains a deliberately PASSING demonstration of a known
///         residual: the staleness clock counts rounds, so a debtor who is
///         willing to fabricate paper can still refresh it. WR-11 raises that
///         price from free to a cold SSTORE per fabricated ref but cannot tell
///         fabricated paper from real.
contract ClearingHubV3PoCTest is RoundBuilderV3 {
    // Victim pair, matching the audit's naming.
    address internal alice; // debtor
    address internal bob; // creditor
    // Unrelated attacker pair: zero collateral, never party to anything.
    address internal mallory;
    address internal trudy;

    function setUp() public {
        _setUpActors();
        alice = actors[0];
        bob = actors[1];
        mallory = actors[3];
        trudy = actors[4]; // actors is ascending, so mallory < trudy
    }

    /// @dev The attacker pair as a 2-participant round shape.
    function _attackerRound() internal view returns (address[] memory p, int256[] memory d) {
        p = new address[](2);
        (p[0], p[1]) = (mallory, trudy);
        d = new int256[](2);
    }

    /// @dev Alice deposits, signs an IOU to Bob, then goes stale (K rounds in
    ///      which she settles nothing). Mirrors the audit's steps 1-2.
    function _victimSetup()
        internal
        returns (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id)
    {
        _fundAndDeposit(alice, 10e6);
        iou = _makeIou(alice, bob, 5e6, 1);
        sig = _signIou(keys[0], iou);
        id = hub.hashIou(iou);
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(alice);
        }
    }

    // ---------------------------------------------------------------- CR-01

    /// Control: absent any attacker, Bob recovers 5 USDC.
    /// (Audit's `test_baseline_redeemSucceeds`.)
    function test_poc0_baseline_redeemSucceeds() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(bob), 5e6, "baseline redemption must work");
        assertEq(hub.collateral(alice), 5e6);
    }

    /// CR-01, by an unrelated third party.
    /// (Audit's `test_poc1_manifestPoisoningBlocksRedemption` — which PASSED
    /// against V2, permanently destroying the IOU's redeemability.)
    ///
    /// Mallory and Trudy hold zero collateral, are not party to the IOU, and
    /// have no signature from Alice or Bob over that id. They write Alice's IOU
    /// id into a round manifest — the best they can do is pair it with their OWN
    /// two addresses, because V3 requires both named parties to be signing
    /// participants. That writes the ledger key `leafId(id, mallory, trudy)`,
    /// which is not the key Bob's redemption reads. The poisoning is inert.
    function test_poc1_manifestPoisoningNoLongerBlocksRedemption() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _victimSetup();

        (address[] memory p, int256[] memory d) = _attackerRound();
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = ClearingHubV3.ConsumedRef({id: id, partyAIdx: 0, partyBIdx: 1});
        _execute(p, d, refs); // the poisoning transaction, and it is accepted

        assertEq(hub.roundNonce(), 4, "poisoning round did execute");
        assertEq(hub.collateral(mallory), 0, "attacker really is capital-free");
        assertTrue(hub.consumed(_leafId(id, mallory, trudy)), "attacker wrote SOME ledger key");
        assertFalse(hub.isConsumed(iou), "...but not the one redemption reads");

        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(bob), 5e6, "poisoning must not block redemption");
        assertEq(hub.collateral(alice), 5e6, "debtor debited exactly amount");
    }

    /// CR-01, by the debtor against their own paper — the natural attacker.
    /// (Audit's `test_poc1b_debtorSelfPoisons`.) Alice knows the id of every
    /// IOU she ever signed. Under V2 one transaction listing them all made her
    /// permanently immune to `redeemIOU`. Under V3 she can only write
    /// `leafId(id, alice, accomplice)`; writing the real `leafId(id, alice, bob)`
    /// would require Bob to be a participant and therefore to sign, and Bob will
    /// not sign away his own claim for nothing.
    function test_poc1b_debtorSelfPoisonIsInert() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig, bytes32 id) = _victimSetup();

        // Alice + an accomplice. Participants must be strictly ascending.
        address[] memory p = new address[](2);
        (p[0], p[1]) = alice < trudy ? (alice, trudy) : (trudy, alice);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = ClearingHubV3.ConsumedRef({id: id, partyAIdx: 0, partyBIdx: 1});
        _execute(p, new int256[](2), refs);

        // Alice's self-poisoning round names her as a party, so it refreshed her
        // own liveness marker; she must go stale again before Bob can act.
        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(alice);
        }

        assertFalse(hub.isConsumed(iou), "self-poisoning wrote a different key");
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(bob), 5e6, "self-poisoning must not defeat redemption");
    }

    /// Why the consumption ledger MUST be keyed on the party-bound leaf.
    ///
    /// This is the single assertion behind the CR-01/CR-02 interaction. Had the
    /// ledger been keyed on the raw id — the obvious reading of the audit's
    /// Option B — an attacker's write and the honest redemption's read would be
    /// THE SAME KEY, and CR-01 would come straight back in a permanent,
    /// unfixable form. Keyed on the bound leaf they are provably distinct.
    function test_poc1c_ledgerKeyMustBePartyBound() public view {
        bytes32 id = keccak256("victim-iou-id");

        // --- raw-id keying (rejected): attacker's write == creditor's read ---
        assertEq(id, id, "a raw-id ledger gives the attacker the honest key");

        // --- party-bound keying (shipped): the two keys can never collide ---
        assertTrue(
            _leafId(id, mallory, trudy) != _leafId(id, alice, bob),
            "party-bound keys must be distinct across pairings"
        );
        // ...and the on-chain derivation agrees with the mirror.
        assertEq(hub.manifestLeafId(id, alice, bob), _leafId(id, alice, bob));
    }

    /// The flip side, so the fix is not mistaken for "redemption always wins":
    /// when the IOU is GENUINELY netted — both parties participating and
    /// signing, which is now the only way — redemption is correctly refused,
    /// permanently. Exclusivity survives the CR-01 fix.
    function test_poc1d_genuineConsumptionStillBlocksRedemption() public {
        _fundAndDeposit(alice, 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(alice, bob, 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);
        bytes32 id = hub.hashIou(iou);

        address[] memory p = new address[](2);
        (p[0], p[1]) = (alice, bob);
        ClearingHubV3.ConsumedRef[] memory refs = new ClearingHubV3.ConsumedRef[](1);
        refs[0] = _refFor(p, id, alice, bob);
        _execute(p, new int256[](2), refs); // an all-cancel round, both consenting

        for (uint256 i; i < K; ++i) {
            _executeRoundWithout(alice);
        }

        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.IouAlreadyNetted.selector, _leafOf(iou))
        );
        hub.redeemIOU(iou, sig);
    }

    /// IN-05, which CR-01 Option B closes as a side effect: the same obligation
    /// can never be netted by two different rounds. Under V2 an id could appear
    /// in unlimited manifests.
    function test_poc_sameIouCannotBeNettedTwice() public {
        address[] memory p = new address[](2);
        (p[0], p[1]) = (alice, bob);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 1, "double-net");
        bytes32 leaf = _leaves(p, refs)[0];

        _execute(p, new int256[](2), refs);

        uint64 nonce_ = hub.roundNonce();
        bytes[] memory sigs = _buildSignatures(nonce_, p, new int256[](2), refs);
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.AlreadyConsumed.selector, leaf));
        hub.executeRound(nonce_, p, new int256[](2), refs, sigs);
    }

    // ---------------------------------------------------------------- CR-02

    /// CR-02: the attack surface is GONE, not priced up.
    ///
    /// (Audit's `test_poc2_ringFlushPermanentlyBlocksRedemption`, which passed
    /// against V2 for ~3.0M gas and permanently killed redemption for EVERY
    /// outstanding IOU on the hub.) The attack worked by evicting root-ring
    /// slots until `oldestExecutedAt` passed the victim's `expiry - L` window.
    /// V3 has no ring, no `executedAt`, no coverage precondition and no proof
    /// set — redemption reads one permanent ledger key.
    ///
    /// Here the attacker executes 32 rounds (twice V2's whole ring), warping
    /// time and paying real gas throughout. Redemption is unaffected.
    function test_poc2_ringFlushSurfaceIsGone() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();

        vm.warp(block.timestamp + 100);
        (address[] memory p, int256[] memory d) = _attackerRound();

        uint256 spent;
        for (uint256 i; i < 32; ++i) {
            uint64 nonce_ = hub.roundNonce();
            ClearingHubV3.ConsumedRef[] memory refs =
                _manifest(p, 1, keccak256(abi.encode("flush", i)));
            bytes[] memory sigs = _buildSignatures(nonce_, p, d, refs);
            uint256 g0 = gasleft();
            hub.executeRound(nonce_, p, d, refs, sigs);
            spent += g0 - gasleft();
        }
        assertEq(hub.roundNonce(), 35, "the attacker really did execute 32 rounds");
        console2.log("CR-02: gas the attacker burned to achieve nothing:", spent);

        // V2 reverted CoverageWindowNotBuffered here, forever. V3 does not.
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(bob), 5e6, "redemption must be unaffected by round spam");
    }

    /// ...and time does not help the attacker either: there is no window to
    /// close, so waiting a week after the spam changes nothing.
    function test_poc2b_flushIsIneffectiveAcrossTime() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();

        (address[] memory p, int256[] memory d) = _attackerRound();
        for (uint256 i; i < 20; ++i) {
            vm.warp(block.timestamp + 1 hours);
            uint64 nonce_ = hub.roundNonce();
            ClearingHubV3.ConsumedRef[] memory refs =
                _manifest(p, 1, keccak256(abi.encode("slow-flush", i)));
            hub.executeRound(nonce_, p, d, refs, _buildSignatures(nonce_, p, d, refs));
        }
        vm.warp(block.timestamp + 7 days);

        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(bob), 5e6, "no time-based window exists to be closed");
    }

    // ---------------------------------------------------------------- WR-11

    /// WR-11, the half that IS closed: co-signing is no longer participation.
    /// Under V2, `lastRound` refreshed for EVERY participant, so an already-
    /// stale debtor could reset their clock by joining any round at all. V3
    /// refreshes only for participants who settled something, so a debtor who
    /// co-signs a round in which they have no delta and no attributed ref stays
    /// stale and stays redeemable-against.
    function test_poc5a_coSigningNoLongerResetsClock() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();

        // A round Alice signs, with a manifest attributed to the OTHER two
        // participants and a zero delta for her.
        address[] memory p = _presentActors(bob);
        ClearingHubV3.ConsumedRef[] memory refs =
            _manifest(p, 1, "not-alices-paper", uint32(1), uint32(2));
        assertTrue(p[0] == alice, "test-internal: alice is participant 0");
        _execute(p, new int256[](p.length), refs);

        assertEq(hub.lastRound(alice), 0, "co-signing must not refresh (WR-11)");
        hub.redeemIOU(iou, sig);
        assertEq(hub.collateral(bob), 5e6, "a keep-alive co-signature must not save the debtor");
    }

    /// WR-11 residual — this test PASSES, and that is the point.
    ///
    /// The staleness clock counts rounds, and the chain cannot tell a fabricated
    /// obligation from a real one. A debtor willing to write a ref naming
    /// themselves still refreshes `lastRound`. What changed is the price: V2
    /// needed only a co-signature on a free round, V3 needs a cold SSTORE into
    /// the consumption ledger for every fabricated ref, and that storage is
    /// occupied permanently.
    function test_poc5b_residual_fabricatedRefStillResetsClock() public {
        (ClearingHubV3.Iou memory iou, bytes memory sig,) = _victimSetup();

        address[] memory p = new address[](2);
        (p[0], p[1]) = alice < trudy ? (alice, trudy) : (trudy, alice);
        ClearingHubV3.ConsumedRef[] memory refs = _manifest(p, 1, "keepalive");
        uint64 nonce_ = hub.roundNonce();
        bytes[] memory sigs = _buildSignatures(nonce_, p, new int256[](2), refs);

        uint256 g0 = gasleft();
        hub.executeRound(nonce_, p, new int256[](2), refs, sigs);
        console2.log("WR-11 residual: gas for one keep-alive round:", g0 - gasleft());

        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.DebtorNotStale.selector, 4, K));
        hub.redeemIOU(iou, sig);
    }

    /// The mirror-image residual, stated so it is not discovered later: because
    /// the clock counts rounds rather than seconds, a third party can also push
    /// others TOWARD staleness by paying for rounds. That only helps someone who
    /// already holds signed paper against the debtor, the debtor can always
    /// defend by settling, and no collateral moves without the debtor's own
    /// signature — but the clock is not tamper-proof in either direction.
    function test_poc_residual_thirdPartyCanAccelerateStaleness() public {
        _fundAndDeposit(alice, 10e6);
        ClearingHubV3.Iou memory iou = _makeIou(alice, bob, 5e6, 1);
        bytes memory sig = _signIou(keys[0], iou);

        // Alice has settled recently, so she is not redeemable-against.
        _executeRoundRefreshingAll(address(0));
        assertEq(hub.lastRound(alice), 1, "alice settled in round 0");
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.DebtorNotStale.selector, 1, K));
        hub.redeemIOU(iou, sig);

        // An unrelated pair pays for K rounds Alice has no part in.
        (address[] memory p, int256[] memory d) = _attackerRound();
        for (uint256 i; i < K; ++i) {
            uint64 nonce_ = hub.roundNonce();
            ClearingHubV3.ConsumedRef[] memory refs =
                _manifest(p, 1, keccak256(abi.encode("accelerate", i)));
            hub.executeRound(nonce_, p, d, refs, _buildSignatures(nonce_, p, d, refs));
        }

        hub.redeemIOU(iou, sig); // now redeemable, purely because rounds happened
        assertEq(hub.collateral(bob), 5e6);
    }
}
