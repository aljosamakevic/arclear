// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./RoundBuilder.sol";
import {ClearingHubV2} from "../../src/ClearingHubV2.sol";
import {PvPRouter} from "../../src/PvPRouter.sol";
import {ManifestMerkle} from "../../src/lib/ManifestMerkle.sol";

/// @dev Dual-hub PvP test harness: two mock tokens, two ClearingHubV2
///      instances (same UNCALIBRATED constructor args as RoundBuilderV2), and
///      one PvPRouter. Ports RoundBuilderV2's round-assembly helpers
///      parameterized by hub, then adds the PvP layer: sorted union merge,
///      PvPRound consent signing, fully-signed Leg assembly, and a canonical
///      overlapping-set bundle (`_simplePvP`). RoundBuilderV2 pins the
///      single-hub tests — this is a separate file so those keep the original.
abstract contract PvPRoundBuilder is Test {
    // Deploy defaults matching DeployV2 / RoundBuilderV2 (UNCALIBRATED, D-08).
    uint64 internal constant K = 3;
    uint64 internal constant RING = 16;
    uint64 internal constant L = 86400;

    uint256 internal constant ACTORS = 5;
    uint256[] internal keys;
    address[] internal actors; // sorted ascending by address

    MockUSDC internal usdc;
    MockUSDC internal eurc;
    ClearingHubV2 internal hubUSDC;
    ClearingHubV2 internal hubEURC;
    PvPRouter internal router;

    /// @dev One fully signed PvP bundle, exactly as executePvP consumes it.
    struct PvPBundle {
        PvPRouter.Leg usdcLeg;
        PvPRouter.Leg eurcLeg;
        bytes32 usdcDigest;
        bytes32 eurcDigest;
        uint256 fxNumerator;
        uint256 fxDenominator;
        bytes[] pvpSignatures;
    }

    function _setUpPvP() internal {
        usdc = new MockUSDC();
        eurc = new MockUSDC(); // same mock shape; the hub only needs an ERC-20
        hubUSDC = new ClearingHubV2(usdc, K, RING, L);
        hubEURC = new ClearingHubV2(eurc, K, RING, L);
        router = new PvPRouter(hubUSDC, hubEURC);

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

    /// @dev Hub-parameterized funding: mint + approve + deposit on the given hub.
    function _fundAndDeposit(ClearingHubV2 hub, MockUSDC token, address actor, uint256 amount)
        internal
    {
        token.mint(actor, amount);
        vm.startPrank(actor);
        token.approve(address(hub), amount);
        hub.deposit(amount);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- manifests

    /// @dev In-place insertion sort; keccak-derived ids are unique, so sorted
    ///      output is strictly ascending as executeRound requires.
    function _sort(bytes32[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; ++i) {
            bytes32 k = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > k) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = k;
        }
    }

    /// @dev m deterministic, strictly-ascending pseudo-IOU ids.
    function _manifest(uint256 m, bytes32 salt) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](m);
        for (uint256 i; i < m; ++i) {
            ids[i] = keccak256(abi.encode(salt, i));
        }
        _sort(ids);
    }

    // ------------------------------------------------------------ leg rounds

    /// @dev Round digest exactly as the given hub derives it: root from
    ///      consumedIds, then the (parity-proven) on-chain hashRound.
    function _digestV2(
        ClearingHubV2 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory consumedIds
    ) internal view returns (bytes32) {
        return hub.hashRound(nonce_, participants, deltas, ManifestMerkle.rootOf(consumedIds));
    }

    function _signRound(
        uint256 pk,
        ClearingHubV2 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory consumedIds
    ) internal view returns (bytes memory) {
        bytes32 digest = _digestV2(hub, nonce_, participants, deltas, consumedIds);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build every participant's consent over the hub's leg digest.
    function _buildSignatures(
        ClearingHubV2 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory consumedIds
    ) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](participants.length);
        for (uint256 i; i < participants.length; ++i) {
            sigs[i] =
                _signRound(_keyOf(participants[i]), hub, nonce_, participants, deltas, consumedIds);
        }
    }

    /// @dev A fully signed Leg exactly as executePvP consumes it.
    function _buildLeg(
        ClearingHubV2 hub,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32[] memory consumedIds
    ) internal view returns (PvPRouter.Leg memory leg) {
        leg.nonce = nonce_;
        leg.participants = participants;
        leg.deltas = deltas;
        leg.consumedIds = consumedIds;
        leg.signatures = _buildSignatures(hub, nonce_, participants, deltas, consumedIds);
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

    /// @dev Assemble a fully signed bundle from two leg specs and a rate:
    ///      leg consents per hub, recomputed leg digests, and union PvP
    ///      signatures over the router's PvPRound digest.
    function _bundle(
        uint64 nonceU,
        address[] memory pU,
        int256[] memory dU,
        bytes32[] memory idsU,
        uint64 nonceE,
        address[] memory pE,
        int256[] memory dE,
        bytes32[] memory idsE,
        uint256 fxNumerator,
        uint256 fxDenominator
    ) internal view returns (PvPBundle memory b) {
        b.usdcLeg = _buildLeg(hubUSDC, nonceU, pU, dU, idsU);
        b.eurcLeg = _buildLeg(hubEURC, nonceE, pE, dE, idsE);
        b.usdcDigest = _digestV2(hubUSDC, nonceU, pU, dU, idsU);
        b.eurcDigest = _digestV2(hubEURC, nonceE, pE, dE, idsE);
        b.fxNumerator = fxNumerator;
        b.fxDenominator = fxDenominator;
        bytes32 pvpDigest =
            router.hashPvPRound(b.usdcDigest, b.eurcDigest, fxNumerator, fxDenominator);
        b.pvpSignatures = _buildPvPSignatures(_union(pU, pE), pvpDigest);
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
        bytes32[] memory idsU = _manifest(3, keccak256(abi.encode("pvp-usdc", salt)));

        address[] memory pE = new address[](3);
        (pE[0], pE[1], pE[2]) = (actors[1], actors[2], actors[3]);
        int256[] memory dE = new int256[](3);
        (dE[0], dE[1], dE[2]) = (int256(-3e6), int256(1e6), int256(2e6));
        bytes32[] memory idsE = _manifest(3, keccak256(abi.encode("pvp-eurc", salt)));

        b = _bundle(
            hubUSDC.roundNonce(), pU, dU, idsU, hubEURC.roundNonce(), pE, dE, idsE, 989_589, 1_000_000
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
}
