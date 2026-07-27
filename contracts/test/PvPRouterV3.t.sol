// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {PvPRoundBuilderV3} from "./utils/PvPRoundBuilderV3.sol";
import {ClearingHubV3} from "../src/ClearingHubV3.sol";
import {PvPRouterV3} from "../src/PvPRouterV3.sol";
import {ManifestMerkle} from "../src/lib/ManifestMerkle.sol";

/// @dev PvPRouterV3 suite: the full PvPRouter.t.sol matrix ported to the V3
///      hub pair, plus the surface V3 adds. Every revert test asserts the
///      both-or-neither postcondition on BOTH hubs after the revert — nonces
///      unchanged and representative collateral reads on each side — because
///      "the transaction reverted" and "no leg settled" are only the same
///      statement if the router never catches anything.
///
///      Three things are genuinely new here versus the V2 suite:
///
///      1. `manifestLeafId` is now implemented in THREE places (hub, router,
///         harness). The parity tests below lock all three together; the fuzz
///         case is the one that would catch a divergence in the ordering rule.
///      2. V3's ref surface is exercised through the router: out-of-range party
///         indices (the router's own named error, pre-empting a Panic), refs
///         not ascending by derived leaf, self-refs, empty rounds, and the
///         permanent consumption ledger — including a second bundle that
///         re-uses already-netted paper, which V2 could not detect at all.
///      3. The domain separator is pinned by string, not just by behaviour, so
///         a rename cannot slip through silently.
contract PvPRouterV3Test is PvPRoundBuilderV3 {
    bytes32 internal constant PVP_ROUND_TYPEHASH = keccak256(
        "PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)"
    );

    function setUp() public {
        _setUpPvPV3();
    }

    // ---------------------------------------------------------- constructor

    function test_constructor_immutables() public view {
        assertEq(address(router.hubUSDC()), address(hubUSDC), "hubUSDC binding");
        assertEq(address(router.hubEURC()), address(hubEURC), "hubEURC binding");
    }

    /// WR-07: the immutables are only as good as what deploy passes. A zero
    /// hub would make every leg call hit an EOA-shaped address.
    function test_revert_constructor_zeroHubUSDC() public {
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.BadConfig.selector));
        new PvPRouterV3(ClearingHubV3(address(0)), hubEURC);
    }

    function test_revert_constructor_zeroHubEURC() public {
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.BadConfig.selector));
        new PvPRouterV3(hubUSDC, ClearingHubV3(address(0)));
    }

    /// WR-07's actual failure mode: one hub on both sides would revert
    /// WrongRoundNonce on the second leg of every normal bundle, bricking the
    /// router with no diagnostic. Rejected at construction instead.
    function test_revert_constructor_sameHubBothLegs() public {
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.BadConfig.selector));
        new PvPRouterV3(hubUSDC, hubUSDC);
    }

    // --------------------------------------------------------- hashPvPRound

    function test_hashPvPRound_fieldSensitivity() public view {
        bytes32 dU = keccak256("usdc-leg-digest");
        bytes32 dE = keccak256("eurc-leg-digest");
        uint256 num = 989_589;
        uint256 den = 1_000_000;

        bytes32 baseline = router.hashPvPRound(dU, dE, num, den);

        // Determinism: same inputs, same digest.
        assertEq(router.hashPvPRound(dU, dE, num, den), baseline, "deterministic");

        // Every one of the 4 fields must move the digest.
        assertNotEq(
            router.hashPvPRound(keccak256("other"), dE, num, den), baseline, "usdcLegDigest inert"
        );
        assertNotEq(
            router.hashPvPRound(dU, keccak256("other"), num, den), baseline, "eurcLegDigest inert"
        );
        assertNotEq(router.hashPvPRound(dU, dE, num + 1, den), baseline, "fxNumerator inert");
        assertNotEq(router.hashPvPRound(dU, dE, num, den + 1), baseline, "fxDenominator inert");
    }

    /// @dev Local EIP-712 recipe, so the domain NAME is pinned as a string
    ///      rather than merely "whatever the contract does".
    function _pvpDigestWithDomainName(string memory name, bytes32 dU, bytes32 dE, uint256 n, uint256 d)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(router)
            )
        );
        bytes32 structHash = keccak256(abi.encode(PVP_ROUND_TYPEHASH, dU, dE, n, d));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// The PvPRound struct is byte-identical to PvPRouter's, so the ONLY thing
    /// separating a V2 bundle consent from a V3 bundle consent is the domain.
    /// Both halves of that separation are asserted: the name string this
    /// router actually uses, and the fact that the V2 name would produce a
    /// different digest over identical fields.
    function test_hashPvPRound_domainIsArclearPvPRouterV3() public view {
        bytes32 dU = keccak256("usdc-leg-digest");
        bytes32 dE = keccak256("eurc-leg-digest");
        bytes32 onchain = router.hashPvPRound(dU, dE, 989_589, 1_000_000);

        assertEq(
            onchain,
            _pvpDigestWithDomainName("ArclearPvPRouterV3", dU, dE, 989_589, 1_000_000),
            "domain name must be ArclearPvPRouterV3"
        );
        assertNotEq(
            onchain,
            _pvpDigestWithDomainName("ArclearPvPRouter", dU, dE, 989_589, 1_000_000),
            "V2 router's domain name must not produce this digest"
        );
    }

    /// Cross-router replay is closed by verifyingContract alone, independently
    /// of the name: a second V3 router over the same hubs (legs swapped) sees
    /// a different digest for identical fields.
    function test_hashPvPRound_verifyingContractSeparatesRouters() public {
        PvPRouterV3 other = new PvPRouterV3(hubEURC, hubUSDC);
        bytes32 dU = keccak256("usdc-leg-digest");
        bytes32 dE = keccak256("eurc-leg-digest");
        assertNotEq(
            router.hashPvPRound(dU, dE, 989_589, 1_000_000),
            other.hashPvPRound(dU, dE, 989_589, 1_000_000),
            "distinct routers must not share consent"
        );
    }

    // ------------------------------------------------------- manifestLeafId
    // Three implementations must agree: hub, router, harness mirror.

    function test_manifestLeafId_matchesBothHubsAndHarness() public view {
        bytes32 id = keccak256("some-iou-id");
        address a = actors[0];
        address b = actors[3];

        bytes32 onRouter = router.manifestLeafId(id, a, b);
        assertEq(onRouter, hubUSDC.manifestLeafId(id, a, b), "router vs hubUSDC");
        assertEq(onRouter, hubEURC.manifestLeafId(id, a, b), "router vs hubEURC");
        assertEq(onRouter, _leafId(id, a, b), "router vs harness mirror");
        // Order insensitivity is load-bearing: it is what removes the
        // role-swap double-spend footgun on the hub side.
        assertEq(onRouter, router.manifestLeafId(id, b, a), "router pair order insensitivity");
    }

    function testFuzz_manifestLeafId_parityWithHub(bytes32 id, address a, address b) public view {
        assertEq(
            router.manifestLeafId(id, a, b),
            hubUSDC.manifestLeafId(id, a, b),
            "router and hub leaf derivations diverge"
        );
        assertEq(
            router.manifestLeafId(id, a, b), router.manifestLeafId(id, b, a), "not order-insensitive"
        );
    }

    // ------------------------------------------------- executePvP: ZeroRate

    function test_revert_executePvP_zeroNumerator() public {
        // Empty legs are fine — the rate gate fires before any leg data is touched.
        PvPRouterV3.Leg memory empty;
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.ZeroRate.selector));
        router.executePvP(empty, empty, bytes32(0), bytes32(0), 0, 1_000_000, new bytes[](0));
    }

    function test_revert_executePvP_zeroDenominator() public {
        PvPRouterV3.Leg memory empty;
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.ZeroRate.selector));
        router.executePvP(empty, empty, bytes32(0), bytes32(0), 989_589, 0, new bytes[](0));
    }

    // -------------------------------------------- executePvP: positive path

    /// Full both-or-neither positive: BOTH hub nonces advance, every
    /// collateral delta on BOTH hubs matches the signed leg exactly, and
    /// PvPExecuted fires with the recomputed digests + rate.
    function test_executePvP_bothLegsSettle() public {
        PvPBundle memory b = _simplePvP("both-legs");

        uint64 nU = hubUSDC.roundNonce();
        uint64 nE = hubEURC.roundNonce();
        uint256[] memory cU = new uint256[](3);
        uint256[] memory cE = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            cU[i] = hubUSDC.collateral(b.usdcLeg.participants[i]);
            cE[i] = hubEURC.collateral(b.eurcLeg.participants[i]);
        }
        bytes32 pvpDigest =
            router.hashPvPRound(b.usdcDigest, b.eurcDigest, b.fxNumerator, b.fxDenominator);

        vm.expectEmit(true, true, true, true, address(router));
        emit PvPRouterV3.PvPExecuted(
            b.usdcDigest, b.eurcDigest, pvpDigest, b.fxNumerator, b.fxDenominator
        );
        _submit(b);

        assertEq(hubUSDC.roundNonce(), nU + 1, "USDC nonce must advance");
        assertEq(hubEURC.roundNonce(), nE + 1, "EURC nonce must advance");
        for (uint256 i; i < 3; ++i) {
            assertEq(
                hubUSDC.collateral(b.usdcLeg.participants[i]),
                uint256(int256(cU[i]) + b.usdcLeg.deltas[i]),
                "USDC collateral delta"
            );
            assertEq(
                hubEURC.collateral(b.eurcLeg.participants[i]),
                uint256(int256(cE[i]) + b.eurcLeg.deltas[i]),
                "EURC collateral delta"
            );
        }
    }

    /// The refs the router forwarded landed, unmodified, in each hub's
    /// permanent consumption ledger — the V3 half of "one IOU, one settlement"
    /// that a PvP bundle must not be able to bypass.
    function test_executePvP_recordsConsumptionOnBothHubs() public {
        PvPBundle memory b = _simplePvP("ledger");
        bytes32[] memory leavesU = _leaves(b.usdcLeg.participants, b.usdcLeg.consumedRefs);
        bytes32[] memory leavesE = _leaves(b.eurcLeg.participants, b.eurcLeg.consumedRefs);

        for (uint256 i; i < leavesU.length; ++i) {
            assertFalse(hubUSDC.consumed(leavesU[i]), "USDC leaf pre-consumed");
            assertFalse(hubEURC.consumed(leavesE[i]), "EURC leaf pre-consumed");
        }

        _submit(b);

        for (uint256 i; i < leavesU.length; ++i) {
            assertTrue(hubUSDC.consumed(leavesU[i]), "USDC leaf not recorded");
            assertTrue(hubEURC.consumed(leavesE[i]), "EURC leaf not recorded");
        }
        // Ledgers are per hub: a USDC leaf is not a EURC leaf.
        assertFalse(hubEURC.consumed(leavesU[0]), "ledgers must not be shared");
    }

    /// Disjoint participant sets: union = concatenation (RESEARCH Q5 — a
    /// signer in one leg only still attests the bundle + rate).
    function test_executePvP_disjointSets() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 5e6);
        _fundAndDeposit(hubEURC, eurc, actors[2], 5e6);

        address[] memory pU = new address[](2);
        (pU[0], pU[1]) = (actors[0], actors[1]);
        int256[] memory dU = new int256[](2);
        (dU[0], dU[1]) = (int256(-1e6), int256(1e6));

        address[] memory pE = new address[](2);
        (pE[0], pE[1]) = (actors[2], actors[3]);
        int256[] memory dE = new int256[](2);
        (dE[0], dE[1]) = (int256(-1e6), int256(1e6));

        PvPBundle memory b = _bundle(
            _spec(hubUSDC.roundNonce(), pU, dU, _manifest(pU, 2, "disjoint-usdc")),
            _spec(hubEURC.roundNonce(), pE, dE, _manifest(pE, 2, "disjoint-eurc")),
            989_589,
            1_000_000
        );
        assertEq(b.pvpSignatures.length, 4, "union must be the 4-member concatenation");

        _submit(b);

        assertEq(hubUSDC.roundNonce(), 1, "USDC nonce must advance");
        assertEq(hubEURC.roundNonce(), 1, "EURC nonce must advance");
        assertEq(hubUSDC.collateral(actors[0]), 4e6, "USDC debtor debited");
        assertEq(hubUSDC.collateral(actors[1]), 1e6, "USDC creditor credited");
        assertEq(hubEURC.collateral(actors[2]), 4e6, "EURC debtor debited");
        assertEq(hubEURC.collateral(actors[3]), 1e6, "EURC creditor credited");
    }

    /// Identical participant sets: union == either set, one signature each.
    function test_executePvP_identicalSets() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 5e6);
        _fundAndDeposit(hubEURC, eurc, actors[2], 5e6);

        address[] memory p = new address[](3);
        (p[0], p[1], p[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-2e6), int256(1e6), int256(1e6));
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(1e6), int256(1e6), int256(-2e6));

        PvPBundle memory b = _bundle(
            _spec(hubUSDC.roundNonce(), p, dU, _manifest(p, 2, "identical-usdc")),
            _spec(hubEURC.roundNonce(), p, dE, _manifest(p, 2, "identical-eurc")),
            989_589,
            1_000_000
        );
        assertEq(b.pvpSignatures.length, 3, "union must collapse to the 3-member set");

        _submit(b);

        assertEq(hubUSDC.roundNonce(), 1, "USDC nonce must advance");
        assertEq(hubEURC.roundNonce(), 1, "EURC nonce must advance");
        assertEq(hubUSDC.collateral(actors[0]), 3e6, "USDC debtor debited");
        assertEq(hubUSDC.collateral(actors[1]), 1e6, "USDC creditor credited");
        assertEq(hubUSDC.collateral(actors[2]), 1e6, "USDC creditor credited (2)");
        assertEq(hubEURC.collateral(actors[0]), 1e6, "EURC creditor credited");
        assertEq(hubEURC.collateral(actors[1]), 1e6, "EURC creditor credited (2)");
        assertEq(hubEURC.collateral(actors[2]), 3e6, "EURC debtor debited");
    }

    // ------------------------------------------- executePvP: revert matrix
    // Every test asserts the both-or-neither postcondition after the revert:
    // both roundNonces unchanged plus representative collateral reads on
    // BOTH hubs (the USDC debtor/creditor and the EURC debtor/creditor).

    /// @dev Snapshot of everything a leaked leg would have to move.
    struct State {
        uint64 nU;
        uint64 nE;
        uint256 cU0;
        uint256 cU2;
        uint256 cE1;
        uint256 cE3;
    }

    function _snapshot() internal view returns (State memory s) {
        s.nU = hubUSDC.roundNonce();
        s.nE = hubEURC.roundNonce();
        s.cU0 = hubUSDC.collateral(actors[0]);
        s.cU2 = hubUSDC.collateral(actors[2]);
        s.cE1 = hubEURC.collateral(actors[1]);
        s.cE3 = hubEURC.collateral(actors[3]);
    }

    function _assertUnchanged(State memory s) internal view {
        assertEq(hubUSDC.roundNonce(), s.nU, "USDC nonce must not advance");
        assertEq(hubEURC.roundNonce(), s.nE, "EURC nonce must not advance");
        assertEq(hubUSDC.collateral(actors[0]), s.cU0, "USDC debtor collateral moved");
        assertEq(hubUSDC.collateral(actors[2]), s.cU2, "USDC creditor collateral moved");
        assertEq(hubEURC.collateral(actors[1]), s.cE1, "EURC debtor collateral moved");
        assertEq(hubEURC.collateral(actors[3]), s.cE3, "EURC creditor collateral moved");
    }

    /// THE atomicity proof (Pitfall 1): the EURC leg fails signature checks
    /// AFTER the USDC leg already executed inside the same call — revert
    /// bubbling must undo the USDC leg's nonce advance, collateral moves AND
    /// its consumption-ledger writes.
    function test_revert_executePvP_badLegSignature() public {
        PvPBundle memory b = _simplePvP("bad-leg-sig");
        // Valid-format signature by a non-participant over the right digest:
        // ECDSA recovers cleanly to the wrong address -> BadSignature(0).
        b.eurcLeg.signatures[0] = _signRound(
            _keyOf(actors[4]),
            hubEURC,
            b.eurcLeg.nonce,
            b.eurcLeg.participants,
            b.eurcLeg.deltas,
            b.eurcLeg.consumedRefs
        );
        bytes32[] memory leavesU = _leaves(b.usdcLeg.participants, b.usdcLeg.consumedRefs);
        State memory s = _snapshot();

        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.BadSignature.selector, 0));
        _submit(b);

        _assertUnchanged(s);
        for (uint256 i; i < leavesU.length; ++i) {
            assertFalse(hubUSDC.consumed(leavesU[i]), "USDC leaf must not stay consumed");
        }
    }

    /// A leg validly signed over a FUTURE nonce passes digest binding and
    /// union consent, then its hub reverts WrongRoundNonce — bubbling takes
    /// the already-executed USDC leg with it.
    function test_revert_executePvP_wrongLegNonce() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 10e6);
        _fundAndDeposit(hubEURC, eurc, actors[1], 10e6);

        address[] memory pU = new address[](3);
        (pU[0], pU[1], pU[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        address[] memory pE = new address[](3);
        (pE[0], pE[1], pE[2]) = (actors[1], actors[2], actors[3]);
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(-3e6), int256(1e6), int256(2e6));

        // EURC leg signed over nonce current+1: stale-by-construction.
        PvPBundle memory b = _bundle(
            _spec(hubUSDC.roundNonce(), pU, dU, _manifest(pU, 3, "wrong-nonce-usdc")),
            _spec(hubEURC.roundNonce() + 1, pE, dE, _manifest(pE, 3, "wrong-nonce-eurc")),
            989_589,
            1_000_000
        );

        State memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.WrongRoundNonce.selector, s.nE, s.nE + 1)
        );
        _submit(b);
        _assertUnchanged(s);
    }

    /// Consented deltas stay valid signatures after a withdrawal — the EURC
    /// debtor drains their collateral post-consent, so the second leg fails
    /// the collateral check and the settled first leg must fully revert.
    function test_revert_executePvP_insufficientCollateralSecondLeg() public {
        PvPBundle memory b = _simplePvP("drained-eurc");
        vm.prank(actors[1]);
        hubEURC.withdraw(10e6); // drain the EURC debtor on the EURC hub only

        State memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingHubV3.InsufficientCollateral.selector, actors[1], 0, 3e6
            )
        );
        _submit(b);
        _assertUnchanged(s);
    }

    /// A paused EURC hub rejects executeRound (RESEARCH Q1.4) — EnforcedPause
    /// bubbles through the router and reverts the executed USDC leg.
    function test_revert_executePvP_pausedHub() public {
        PvPBundle memory b = _simplePvP("paused-eurc");
        hubEURC.pause(); // harness is the owner

        State memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        _submit(b);
        _assertUnchanged(s);
    }

    /// A tampered union signature (valid format, wrong recovered address at
    /// index 1) is rejected before either hub is called.
    function test_revert_executePvP_badPvPSignature() public {
        PvPBundle memory b = _simplePvP("bad-pvp-sig");
        bytes32 pvpDigest =
            router.hashPvPRound(b.usdcDigest, b.eurcDigest, b.fxNumerator, b.fxDenominator);
        b.pvpSignatures[1] = _signPvP(_keyOf(actors[4]), pvpDigest); // not union_[1]

        State memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.BadPvPSignature.selector, 1));
        _submit(b);
        _assertUnchanged(s);
    }

    /// Dropping one union signature trips the exact-count rule: every union
    /// member must consent, no exceptions.
    function test_revert_executePvP_pvpSignatureCountMismatch() public {
        PvPBundle memory b = _simplePvP("dropped-sig");
        bytes[] memory short_ = new bytes[](b.pvpSignatures.length - 1);
        for (uint256 i; i < short_.length; ++i) {
            short_[i] = b.pvpSignatures[i];
        }
        b.pvpSignatures = short_; // union of {A,B,C} u {B,C,D} = 4, provided 3

        State memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(PvPRouterV3.PvPSignatureCountMismatch.selector, 4, 3)
        );
        _submit(b);
        _assertUnchanged(s);
    }

    /// Disordered participants in one leg break the merged stream's strict
    /// ascent — rejected router-locally, before any hub call. The leg digest
    /// is recomputed over the swapped array so binding passes and the union
    /// merge is the check that fires. (The manifest leaves are unaffected:
    /// both refs name the pair {p[0], p[1]}, and manifestLeafId orders that
    /// pair canonically, so swapping the two participants leaves the derived
    /// root identical.)
    function test_revert_executePvP_unionDisorder() public {
        PvPBundle memory b = _simplePvP("union-disorder");
        (b.usdcLeg.participants[0], b.usdcLeg.participants[1]) =
            (b.usdcLeg.participants[1], b.usdcLeg.participants[0]);
        b.usdcDigest = _digestV3(
            hubUSDC,
            b.usdcLeg.nonce,
            b.usdcLeg.participants,
            b.usdcLeg.deltas,
            b.usdcLeg.consumedRefs
        );

        State memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.UnionNotStrictlyAscending.selector));
        _submit(b);
        _assertUnchanged(s);
    }

    /// A signed digest that does not match the recomputed calldata digest is
    /// rejected per leg, before any execution (Pitfall 2).
    function test_revert_executePvP_legDigestMismatch() public {
        PvPBundle memory b = _simplePvP("digest-mismatch");
        State memory s = _snapshot();

        bytes32 goodU = b.usdcDigest;
        b.usdcDigest = keccak256("wrong-usdc-digest");
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.LegDigestMismatch.selector, 0));
        _submit(b);

        b.usdcDigest = goodU;
        b.eurcDigest = keccak256("wrong-eurc-digest");
        vm.expectRevert(abi.encodeWithSelector(PvPRouterV3.LegDigestMismatch.selector, 1));
        _submit(b);

        _assertUnchanged(s);
    }

    /// Structural replay protection (RESEARCH Q2): each signed leg digest
    /// binds its hub's roundNonce, so re-submitting the identical calldata
    /// reverts WrongRoundNonce with NO router state involved.
    function test_revert_executePvP_replaySameBundle() public {
        PvPBundle memory b = _simplePvP("replay");
        _submit(b); // first submission settles both legs

        State memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.WrongRoundNonce.selector, s.nU, 0));
        _submit(b); // identical calldata
        _assertUnchanged(s);
    }

    // ------------------------------- executePvP: V3-specific ref surface

    /// V3's second, independent replay barrier — one the V2 router could not
    /// have: a FRESHLY SIGNED bundle at the current nonces that re-uses paper
    /// an earlier bundle already netted is rejected by the consumption ledger.
    /// Placed on the EURC (second) leg, so the USDC leg has already executed
    /// when it fires — atomicity again.
    function test_revert_executePvP_alreadyConsumedLeafSecondLeg() public {
        PvPBundle memory first = _simplePvP("consume-once");
        _submit(first);

        // Re-fund and rebuild at the NEW nonces: fresh USDC paper, but the
        // EURC leg carries the exact refs (same ids, same party pair) the
        // first bundle already netted.
        _fundAndDeposit(hubUSDC, usdc, actors[0], 10e6);
        _fundAndDeposit(hubEURC, eurc, actors[1], 10e6);

        address[] memory pU = new address[](3);
        (pU[0], pU[1], pU[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        address[] memory pE = new address[](3);
        (pE[0], pE[1], pE[2]) = (actors[1], actors[2], actors[3]);
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(-3e6), int256(1e6), int256(2e6));

        ClearingHubV3.ConsumedRef[] memory reused =
            _manifest(pE, 3, keccak256(abi.encode("pvp-eurc", bytes32("consume-once"))));
        bytes32 firstLeaf = _leafId(reused[0].id, pE[reused[0].partyAIdx], pE[reused[0].partyBIdx]);
        assertTrue(hubEURC.consumed(firstLeaf), "precondition: leaf already netted");

        PvPBundle memory b = _bundle(
            _spec(hubUSDC.roundNonce(), pU, dU, _manifest(pU, 3, "consume-once-2")),
            _spec(hubEURC.roundNonce(), pE, dE, reused),
            989_589,
            1_000_000
        );

        State memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.AlreadyConsumed.selector, firstLeaf)
        );
        _submit(b);
        _assertUnchanged(s);
    }

    /// A ref naming a participant index that does not exist would index past
    /// `participants` while the router derives the leg's leaves. The router
    /// names it rather than emitting Panic(0x32) (WR-08 class), tagging the
    /// leg — here the EURC leg, so `leg == 1`.
    function test_revert_executePvP_legPartyIndexOutOfRange() public {
        PvPBundle memory b = _simplePvP("oob-index");
        b.eurcLeg.consumedRefs[0].partyAIdx = 99;

        State memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(PvPRouterV3.LegPartyIndexOutOfRange.selector, 1, 0, 99, 3)
        );
        _submit(b);
        _assertUnchanged(s);
    }

    /// Same on the USDC leg, to pin the leg tag itself.
    function test_revert_executePvP_legPartyIndexOutOfRange_usdcLegTagged() public {
        PvPBundle memory b = _simplePvP("oob-index-usdc");
        b.usdcLeg.consumedRefs[1].partyBIdx = 7;

        State memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(PvPRouterV3.LegPartyIndexOutOfRange.selector, 0, 1, 7, 3)
        );
        _submit(b);
        _assertUnchanged(s);
    }

    /// V3 orders manifests by DERIVED LEAF, not by raw id. A leg whose refs
    /// are out of that order is rejected by `rootOf` inside the router, before
    /// any signature work — the same UnsortedLeaves the hub would raise.
    function test_revert_executePvP_refsNotAscendingByLeaf() public {
        PvPBundle memory b = _simplePvP("unsorted-refs");
        (b.eurcLeg.consumedRefs[0], b.eurcLeg.consumedRefs[1]) =
            (b.eurcLeg.consumedRefs[1], b.eurcLeg.consumedRefs[0]);

        State memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(ManifestMerkle.UnsortedLeaves.selector, 1));
        _submit(b);
        _assertUnchanged(s);
    }

    /// A ref naming the same participant twice is structurally not an IOU.
    /// The router derives its leaf without complaint (the pair orders to
    /// (a, a)); the HUB rejects it, and the revert bubbles.
    function test_revert_executePvP_selfConsumedRefBubblesFromHub() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 10e6);
        _fundAndDeposit(hubEURC, eurc, actors[1], 10e6);

        address[] memory pU = new address[](3);
        (pU[0], pU[1], pU[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        address[] memory pE = new address[](3);
        (pE[0], pE[1], pE[2]) = (actors[1], actors[2], actors[3]);
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(-3e6), int256(1e6), int256(2e6));

        PvPBundle memory b = _bundle(
            _spec(hubUSDC.roundNonce(), pU, dU, _manifest(pU, 3, "self-ref-usdc")),
            // both party indices are participant 2 of the EURC leg
            _spec(hubEURC.roundNonce(), pE, dE, _manifest(pE, 3, "self-ref-eurc", 2, 2)),
            989_589,
            1_000_000
        );

        State memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.SelfConsumedRef.selector, 0));
        _submit(b);
        _assertUnchanged(s);
    }

    /// A leg that neither moves value nor consumes paper only advances a
    /// roundNonce, which pushes every non-participant closer to being
    /// redeemable-against. V3 rejects it; through the router it takes the
    /// other leg down with it.
    function test_revert_executePvP_emptyRoundBubblesFromHub() public {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 10e6);

        address[] memory pU = new address[](3);
        (pU[0], pU[1], pU[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        address[] memory pE = new address[](3);
        (pE[0], pE[1], pE[2]) = (actors[1], actors[2], actors[3]);

        PvPBundle memory b = _bundle(
            _spec(hubUSDC.roundNonce(), pU, dU, _manifest(pU, 3, "empty-round-usdc")),
            _spec(
                hubEURC.roundNonce(),
                pE,
                new int256[](3),
                new ClearingHubV3.ConsumedRef[](0)
            ),
            989_589,
            1_000_000
        );

        State memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(ClearingHubV3.EmptyRound.selector));
        _submit(b);
        _assertUnchanged(s);
    }

    // ---------------------------------------------- documented limitation

    /// MACHINE-DOCUMENTED LIMITATION (RESEARCH Q2c, accept-and-document;
    /// D-13 cites this test). Leg consents are ordinary, valid standalone hub
    /// Round signatures: an adversary who obtains one leg's complete
    /// signature set — including by extracting it from this router's pending
    /// transaction in the mempool — can settle that leg DIRECTLY on its hub,
    /// without its twin. PvP both-or-neither holds within the router path
    /// and against every failure/revert mode above; it does NOT hold against
    /// unilateral direct submission of one leg. The downgrade is bounded: the
    /// settled leg moved only unanimously signed balances, and the open leg's
    /// obligations remain ordinary collateral-backed credit (nettable later,
    /// recoverable via redeemIOU) — never unsigned movement. V3 does not
    /// change this: party-bound refs and the consumption ledger constrain
    /// WHICH paper a leg may extinguish, not whether a fully-signed leg can be
    /// submitted on its own. See docs/THREAT-MODEL.md (single-leg extraction)
    /// for the full analysis and the signature custody discipline that
    /// narrows the window.
    function test_singleLegDirectSubmissionSettles() public {
        PvPBundle memory b = _simplePvP("single-leg");

        uint64 nU = hubUSDC.roundNonce();
        uint256 cU0 = hubUSDC.collateral(actors[0]);
        uint256 cU1 = hubUSDC.collateral(actors[1]);
        uint256 cU2 = hubUSDC.collateral(actors[2]);

        // The USDC leg's calldata + signatures, submitted directly to the
        // hub, bypassing the router entirely: it SETTLES.
        hubUSDC.executeRound(
            b.usdcLeg.nonce,
            b.usdcLeg.participants,
            b.usdcLeg.deltas,
            b.usdcLeg.consumedRefs,
            b.usdcLeg.signatures
        );

        assertEq(hubUSDC.roundNonce(), nU + 1, "single leg must settle: nonce advances");
        assertEq(
            hubUSDC.collateral(actors[0]),
            uint256(int256(cU0) + b.usdcLeg.deltas[0]),
            "single leg must settle: debtor debited"
        );
        assertEq(
            hubUSDC.collateral(actors[1]),
            uint256(int256(cU1) + b.usdcLeg.deltas[1]),
            "single leg must settle: creditor credited"
        );
        assertEq(
            hubUSDC.collateral(actors[2]),
            uint256(int256(cU2) + b.usdcLeg.deltas[2]),
            "single leg must settle: creditor credited (2)"
        );

        // The router bundle is now structurally dead: the USDC leg's signed
        // nonce is consumed, so the atomic path reverts WrongRoundNonce.
        vm.expectRevert(
            abi.encodeWithSelector(ClearingHubV3.WrongRoundNonce.selector, nU + 1, nU)
        );
        _submit(b);
    }
}
