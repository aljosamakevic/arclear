// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./RoundBuilder.sol";
import {ClearingHubV3} from "../../src/ClearingHubV3.sol";
import {PvPRouterV3} from "../../src/PvPRouterV3.sol";
import {ManifestMerkle} from "../../src/lib/ManifestMerkle.sol";

/// @dev Dual-hub V3 PvP test harness: two mock tokens, two ClearingHubV3
///      instances (same UNCALIBRATED K as RoundBuilderV3) and one PvPRouterV3.
///      It is PvPRoundBuilder crossed with RoundBuilderV3 — the dual-hub PvP
///      layer (sorted union merge, PvPRound consent signing, fully-signed Leg
///      assembly, canonical overlapping bundle) over V3's ref-based manifests.
///
///      Two things differ from the V2 PvP harness, both because of V3's CR-01
///      party binding:
///
///      1. Manifests are `ConsumedRef[]` and the merkle leaf is the PARTY-BOUND
///         `manifestLeafId(id, a, b)`, so every manifest helper needs the leg's
///         `participants` array to derive leaves — sorting is BY DERIVED LEAF,
///         not by raw id, because that is what `rootOf` sees.
///      2. Leaves land in each hub's permanent consumption ledger, so no two
///         bundles in one test may reuse a (id, party-pair). Every manifest here
///         is salted per test and per leg for that reason.
///
///      PvPRoundBuilder pins the V2 router's tests — this is a separate file so
///      those keep the original harness untouched.
abstract contract PvPRoundBuilderV3 is Test {
    // Deploy default matching DeployV3 / RoundBuilderV3 (UNCALIBRATED, D-08).
    uint64 internal constant K = 3;

    uint256 internal constant ACTORS = 5;
    uint256[] internal keys;
    address[] internal actors; // sorted ascending by address

    MockUSDC internal usdc;
    MockUSDC internal eurc;
    ClearingHubV3 internal hubUSDC;
    ClearingHubV3 internal hubEURC;
    PvPRouterV3 internal router;

    /// @dev One fully signed PvP bundle, exactly as executePvP consumes it.
    struct PvPBundle {
        PvPRouterV3.Leg usdcLeg;
        PvPRouterV3.Leg eurcLeg;
        bytes32 usdcDigest;
        bytes32 eurcDigest;
        uint256 fxNumerator;
        uint256 fxDenominator;
        bytes[] pvpSignatures;
    }

    function _setUpPvPV3() internal {
        usdc = new MockUSDC();
        eurc = new MockUSDC(); // same mock shape; the hub only needs an ERC-20
        hubUSDC = new ClearingHubV3(usdc, K);
        hubEURC = new ClearingHubV3(eurc, K);
        router = new PvPRouterV3(hubUSDC, hubEURC);

        // Derive actors, then sort (participants must be strictly ascending).
        uint256[] memory ks = new uint256[](ACTORS);
        address[] memory as_ = new address[](ACTORS);
        for (uint256 i; i < ACTORS; ++i) {
            ks[i] = uint256(keccak256(abi.encode("arclear-actor", i)));
            as_[i] = vm.addr(ks[i]);
        }
        for (uint256 i; i < ACTORS; ++i) {
            for (uint256 j = i + 1; j < ACTORS; ++j) {
                if (as_[j] < as_[i]) {
                    (as_[i], as_[j]) = (as_[j], as_[i]);
                    (ks[i], ks[j]) = (ks[j], ks[i]);
                }
            }
        }
        for (uint256 i; i < ACTORS; ++i) {
            keys.push(ks[i]);
            actors.push(as_[i]);
        }
    }

    function _keyOf(address actor) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == actor) return keys[i];
        }
        revert("unknown actor");
    }

    function _indexOf(address[] memory p, address who) internal pure returns (uint32) {
        for (uint256 i; i < p.length; ++i) {
            if (p[i] == who) return uint32(i);
        }
        revert("not a participant");
    }

    /// @dev Hub-parameterized funding: mint + approve + deposit on the given hub.
    function _fundAndDeposit(ClearingHubV3 hub, MockUSDC token, address actor, uint256 amount)
        internal
    {
        token.mint(actor, amount);
        vm.startPrank(actor);
        token.approve(address(hub), amount);
        hub.deposit(amount);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- manifests

    /// @dev Local mirror of ClearingHubV3.manifestLeafId (parity-asserted
    ///      against BOTH the hub and the router in PvPRouterV3.t.sol).
    function _leafId(bytes32 id, address a, address b) internal pure returns (bytes32) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(id, lo, hi));
    }

    /// @dev Derive the leaf vector a ref list commits, in ref order.
    function _leaves(address[] memory p, ClearingHubV3.ConsumedRef[] memory refs)
        internal
        pure
        returns (bytes32[] memory out)
    {
        out = new bytes32[](refs.length);
        for (uint256 i; i < refs.length; ++i) {
            out[i] = _leafId(refs[i].id, p[refs[i].partyAIdx], p[refs[i].partyBIdx]);
        }
    }

    /// @dev In-place insertion sort of refs by DERIVED LEAF — the order rootOf
    ///      demands. keccak-derived leaves are unique, so the result is strictly
    ///      ascending.
    function _sortRefs(address[] memory p, ClearingHubV3.ConsumedRef[] memory refs) internal pure {
        for (uint256 i = 1; i < refs.length; ++i) {
            ClearingHubV3.ConsumedRef memory cur = refs[i];
            bytes32 curLeaf = _leafId(cur.id, p[cur.partyAIdx], p[cur.partyBIdx]);
            uint256 j = i;
            while (j > 0) {
                ClearingHubV3.ConsumedRef memory prev = refs[j - 1];
                if (_leafId(prev.id, p[prev.partyAIdx], p[prev.partyBIdx]) <= curLeaf) break;
                refs[j] = prev;
                --j;
            }
            refs[j] = cur;
        }
    }

    /// @dev m deterministic refs, all attributed to participants[a]/[b], sorted
    ///      by derived leaf.
    function _manifest(address[] memory p, uint256 m, bytes32 salt, uint32 a, uint32 b)
        internal
        pure
        returns (ClearingHubV3.ConsumedRef[] memory refs)
    {
        refs = new ClearingHubV3.ConsumedRef[](m);
        for (uint256 i; i < m; ++i) {
            refs[i] = ClearingHubV3.ConsumedRef({
                id: keccak256(abi.encode(salt, i)),
                partyAIdx: a,
                partyBIdx: b
            });
        }
        _sortRefs(p, refs);
    }

    /// @dev Default attribution (participants 0 and 1).
    function _manifest(address[] memory p, uint256 m, bytes32 salt)
        internal
        pure
        returns (ClearingHubV3.ConsumedRef[] memory)
    {
        return _manifest(p, m, salt, 0, 1);
    }

    // ------------------------------------------------------------ leg rounds

    /// @dev Round digest exactly as the given hub derives it: root over the
    ///      DERIVED leaves, then the (parity-proven) on-chain hashRound.
    function _digestV3(
        ClearingHubV3 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal view returns (bytes32) {
        return hub.hashRound(
            nonce_, participants, deltas, ManifestMerkle.rootOf(_leaves(participants, refs))
        );
    }

    function _signRound(
        uint256 pk,
        ClearingHubV3 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal view returns (bytes memory) {
        bytes32 digest = _digestV3(hub, nonce_, participants, deltas, refs);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build every participant's consent over the hub's leg digest.
    function _buildSignatures(
        ClearingHubV3 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](participants.length);
        for (uint256 i; i < participants.length; ++i) {
            sigs[i] = _signRound(_keyOf(participants[i]), hub, nonce_, participants, deltas, refs);
        }
    }

    /// @dev A fully signed Leg exactly as executePvP consumes it.
    function _buildLeg(
        ClearingHubV3 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal view returns (PvPRouterV3.Leg memory leg) {
        leg.nonce = nonce_;
        leg.participants = participants;
        leg.deltas = deltas;
        leg.consumedRefs = refs;
        leg.signatures = _buildSignatures(hub, nonce_, participants, deltas, refs);
    }

    // ------------------------------------------------------------- pvp layer

    /// @dev Sorted merge of two strictly-ascending address lists into their
    ///      ascending union — the same spec the router implements on-chain.
    function _union(address[] memory a, address[] memory b)
        internal
        pure
        returns (address[] memory out)
    {
        address[] memory buf = new address[](a.length + b.length);
        uint256 i;
        uint256 j;
        uint256 count;
        while (i < a.length || j < b.length) {
            if (j == b.length || (i < a.length && a[i] < b[j])) {
                buf[count++] = a[i++];
            } else if (i == a.length || b[j] < a[i]) {
                buf[count++] = b[j++];
            } else {
                buf[count++] = a[i];
                ++i;
                ++j;
            }
        }
        out = new address[](count);
        for (uint256 k; k < count; ++k) {
            out[k] = buf[k];
        }
    }

    function _signPvP(uint256 pk, bytes32 pvpDigest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pvpDigest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev One PvPRound signature per union member, index-aligned to the
    ///      merged ascending order — exactly what executePvP verifies.
    function _buildPvPSignatures(address[] memory union_, bytes32 pvpDigest)
        internal
        view
        returns (bytes[] memory sigs)
    {
        sigs = new bytes[](union_.length);
        for (uint256 i; i < union_.length; ++i) {
            sigs[i] = _signPvP(_keyOf(union_[i]), pvpDigest);
        }
    }

    /// @dev The two leg specs of a bundle, grouped so `_bundle` stays under the
    ///      stack limit now that refs replace plain id arrays.
    struct LegSpec {
        uint64 nonce;
        address[] participants;
        int256[] deltas;
        ClearingHubV3.ConsumedRef[] refs;
    }

    function _spec(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        ClearingHubV3.ConsumedRef[] memory refs
    ) internal pure returns (LegSpec memory s) {
        s.nonce = nonce_;
        s.participants = participants;
        s.deltas = deltas;
        s.refs = refs;
    }

    /// @dev Assemble a fully signed bundle from two leg specs and a rate:
    ///      leg consents per hub, recomputed leg digests, and union PvP
    ///      signatures over the router's PvPRound digest.
    function _bundle(
        LegSpec memory u,
        LegSpec memory e,
        uint256 fxNumerator,
        uint256 fxDenominator
    ) internal view returns (PvPBundle memory b) {
        b.usdcLeg = _buildLeg(hubUSDC, u.nonce, u.participants, u.deltas, u.refs);
        b.eurcLeg = _buildLeg(hubEURC, e.nonce, e.participants, e.deltas, e.refs);
        b.usdcDigest = _digestV3(hubUSDC, u.nonce, u.participants, u.deltas, u.refs);
        b.eurcDigest = _digestV3(hubEURC, e.nonce, e.participants, e.deltas, e.refs);
        b.fxNumerator = fxNumerator;
        b.fxDenominator = fxDenominator;
        bytes32 pvpDigest =
            router.hashPvPRound(b.usdcDigest, b.eurcDigest, fxNumerator, fxDenominator);
        b.pvpSignatures = _buildPvPSignatures(_union(u.participants, e.participants), pvpDigest);
    }

    /// @dev Canonical bundle at the hubs' current nonces: USDC leg over
    ///      {A,B,C} = actors[0..2], EURC leg over {B,C,D} = actors[1..3] —
    ///      overlapping union of 4 (differing sets are the NORMAL case per
    ///      RESEARCH Q5). Distinct salted manifests per leg, fixed rate
    ///      989589/1000000. Funds each leg's debtor with 10e6 on its hub.
    function _simplePvP(bytes32 salt) internal returns (PvPBundle memory b) {
        _fundAndDeposit(hubUSDC, usdc, actors[0], 10e6);
        _fundAndDeposit(hubEURC, eurc, actors[1], 10e6);

        address[] memory pU = new address[](3);
        (pU[0], pU[1], pU[2]) = (actors[0], actors[1], actors[2]);
        int256[] memory dU = new int256[](3);
        (dU[0], dU[1], dU[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        ClearingHubV3.ConsumedRef[] memory refsU =
            _manifest(pU, 3, keccak256(abi.encode("pvp-usdc", salt)));

        address[] memory pE = new address[](3);
        (pE[0], pE[1], pE[2]) = (actors[1], actors[2], actors[3]);
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        ClearingHubV3.ConsumedRef[] memory refsE =
            _manifest(pE, 3, keccak256(abi.encode("pvp-eurc", salt)));

        b = _bundle(
            _spec(hubUSDC.roundNonce(), pU, dU, refsU),
            _spec(hubEURC.roundNonce(), pE, dE, refsE),
            989_589,
            1_000_000
        );
    }

    /// @dev Submit a bundle. The router call is the ONLY external call made
    ///      here, so `vm.expectRevert`/`vm.expectEmit` placed immediately
    ///      before `_submit` target executePvP.
    function _submit(PvPBundle memory b) internal {
        router.executePvP(
            b.usdcLeg,
            b.eurcLeg,
            b.usdcDigest,
            b.eurcDigest,
            b.fxNumerator,
            b.fxDenominator,
            b.pvpSignatures
        );
    }

    /// @dev The calldata a submitter actually pays intrinsic gas for.
    function _submitCalldata(PvPBundle memory b) internal pure returns (bytes memory) {
        return abi.encodeCall(
            PvPRouterV3.executePvP,
            (
                b.usdcLeg,
                b.eurcLeg,
                b.usdcDigest,
                b.eurcDigest,
                b.fxNumerator,
                b.fxDenominator,
                b.pvpSignatures
            )
        );
    }
}
