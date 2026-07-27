// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ManifestMerkle} from "./lib/ManifestMerkle.sol";

/// @title ClearingHubV3 — multilateral obligation netting for one ERC-20 (Arclear Net v3)
/// @notice Revision of ClearingHubV2 that closes both redeploy-class findings of
///         the 2026-07-27 contract audit. The netting protocol is unchanged: a
///         round executes only with a valid EIP-712 signature from EVERY listed
///         participant over one shared digest of the full position set
///         (unanimity over the final executed set), and `executeRound` stays
///         permissionless given those signatures.
/// @dev    **What changed vs V2, and why.**
///
///         (CR-01 — manifest poisoning) V2 accepted a bare `bytes32[]
///         consumedIds` and committed its merkle root without ever binding an id
///         to anybody. Since a round was cheap and needed no collateral, ANY
///         address pair — canonically the debtor themselves — could write a
///         victim IOU's id into a manifest, after which a non-inclusion proof
///         for that id could never exist again and `redeemIOU` was permanently
///         defeated for it.
///
///         V3 replaces the id list with `ConsumedRef[]`: each entry carries the
///         id plus the two INDICES, into this round's `participants` array, of
///         the IOU's two parties. The committed manifest leaf is no longer the
///         raw id but `manifestLeafId(id, partyA, partyB)` — a commitment to the
///         id AND the (canonically ordered) party pair. Consuming a real IOU
///         therefore requires both of its parties to be listed participants, and
///         every listed participant must sign the round digest; a creditor will
///         not sign a round that extinguishes their claim without paying them
///         (their own off-chain re-verification recomputes the whole proposal).
///         An attacker who pairs a victim's id with their OWN addresses derives
///         a DIFFERENT leaf, which cannot collide with the honest
///         `(id, debtor, creditor)` leaf. Poisoning became a no-op.
///
///         (CR-02 — root-ring flush) V2 recorded manifests in a RING-slot ring
///         buffer of merkle roots, and `redeemIOU` demanded a non-inclusion
///         proof against every buffered root plus a "coverage" precondition
///         comparing the oldest buffered `executedAt` against `expiry - L`.
///         Because `roundNonce` could be advanced cheaply and `oldestExecutedAt`
///         only ever increases, an attacker could permanently close that window
///         for every outstanding IOU on the hub. Pricing rounds up does not fix
///         this: the window is compressible by anyone willing to pay, and no
///         guard that keeps the ring can make it uncompressible without capping
///         round throughput.
///
///         V3 therefore replaces the entire negative-proof regime with a
///         positive on-chain **consumption ledger**: `executeRound` writes
///         `consumed[leafId] = true` for every consumed ref, and `redeemIOU`
///         simply refuses when `consumed[leafId(iou)]` is set. Redemption is now
///         O(1), takes no proofs, and its guarantee cannot be eroded by anything
///         a third party does. THE LEDGER IS KEYED ON THE PARTY-BOUND LEAF, NOT
///         THE RAW ID — this is load-bearing. A ledger keyed on the raw id would
///         hand CR-01 straight back, since anyone could mark a victim's id
///         consumed forever; keyed on the bound leaf, a poisoner's write lands
///         on a key no honest redemption ever reads.
///
///         Deleted with the ring: `rootRing`, `StoredRoot`, the `RING` and
///         `MAX_IOU_LIFETIME` (L) immutables and their constructor parameters,
///         the coverage precondition, and the non-inclusion proof arguments on
///         `redeemIOU`. Findings WR-01 (a `leafCount` large enough to panic the
///         verifier) and WR-03 (the coverage rule penalising short-lived, safer
///         IOUs) are removed along with the surface that carried them, as is
///         IN-05 (one id could previously appear in unlimited round manifests —
///         `AlreadyConsumed` now makes "one IOU, one settlement" an on-chain
///         invariant rather than a coordinator convention).
///
///         **The merkle manifest commitment is deliberately KEPT.** `rootOf`
///         still derives `manifestHash` on-chain from calldata and it still
///         travels into the signed `Round` digest, so signatures transitively
///         bind the exact leaf set and every round's manifest stays publicly
///         reconstructible. What was replaced is the redemption PROOF
///         mechanism, not the commitment: the EIP-712 struct, the shared digest
///         fixtures, `ManifestMerkle.sol` and its TS twin `src/merkle.ts` all
///         remain load-bearing and unchanged.
///
///         Also taken from the same audit: WR-06 (`renounceOwnership` disabled —
///         renouncing while paused would make `unpause` unreachable and brick
///         deposits, rounds and redemption forever), WR-11 (`lastRound` refreshes
///         only for participants who actually settled something — see
///         `executeRound`), and IN-04 (zero-address IOU parties rejected).
///
///         **Unchanged from V2, deliberately:** the EIP-712 domain
///         ("ArcClearingHub", "1"), ROUND_TYPEHASH, IOU_TYPEHASH, `hashRound`,
///         `hashIou`, zero-sum enforcement, strictly-ascending participants,
///         unanimous consent, the never-pausable `withdraw`, the `redeemed`
///         nullifier, the staleness gate, and the absence of division from all
///         protocol math. Digest parity with the v1/v2 fixtures still holds —
///         only the DERIVATION of the `manifestHash` inside the digest changed.
///
///         **Known residual (nonce-paced staleness).** The staleness gate counts
///         rounds, not seconds, so anyone willing to pay for rounds can still
///         move the clock: a debtor can refresh their own `lastRound` by
///         settling or consuming something (WR-11 raises the price to a cold
///         SSTORE per fabricated ref but cannot distinguish fabricated paper
///         from real), and conversely a third party can accelerate everyone
///         else's staleness by paying for rounds. Both directions are inherent
///         to a round-counted clock and are documented rather than claimed
///         closed; neither can move collateral without the affected party's
///         signature.
///
///         No owner access to funds, no upgradeability, no fees; `pause` gates
///         deposits, rounds, and redemptions but never withdrawal.
contract ClearingHubV3 is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The single ERC-20 this hub clears. Fee-on-transfer tokens are
    ///         unsupported (deposit assumes amount received == amount sent).
    IERC20 public immutable token;

    /// @notice Nonce of the next round to execute; increments once per round.
    uint64 public roundNonce;

    /// @notice Free collateral per participant, in token base units.
    mapping(address => uint256) public collateral;

    bytes32 private constant ROUND_TYPEHASH = keccak256(
        "Round(uint64 roundNonce,address[] participants,int256[] deltas,bytes32 manifestHash)"
    );

    // ------------------------------------------------------------------
    // Redemption state — layout kept diffable against V2 for audit purposes.
    // ------------------------------------------------------------------

    /// @notice One off-chain obligation, exactly as the debtor signed it.
    /// @dev    Field order and types byte-match IOU_TYPES in src/domain.ts
    ///         (note `expiry` IS uint64 there) — hashIou parity depends on it.
    struct Iou {
        address debtor;
        address creditor;
        uint256 amount;
        uint256 nonce;
        uint64 expiry;
        bytes32 ref;
    }

    /// @notice One IOU consumed by a round, bound to its two parties.
    /// @dev    THE CR-01 FIX. `partyAIdx` and `partyBIdx` index this round's
    ///         `participants` array and must identify the IOU's debtor and its
    ///         creditor — in either order, because `manifestLeafId` orders the
    ///         pair canonically before hashing. Order-insensitivity is
    ///         deliberate: it removes a silent double-spend footgun where a
    ///         coordinator that swapped the two roles would commit a leaf that
    ///         the creditor's later redemption check does not read, leaving a
    ///         genuinely-netted IOU still redeemable.
    struct ConsumedRef {
        bytes32 id; // the IOU id == hashIou(iou)
        uint32 partyAIdx; // index into participants of one party
        uint32 partyBIdx; // index into participants of the other party
    }

    /// @notice Consumption ledger: the set of manifest leaves any round has
    ///         ever netted. THE CR-02 FIX, and the whole of the redemption
    ///         precondition — `redeemIOU` refuses exactly when this is set.
    /// @dev    Keyed by the PARTY-BOUND leaf `manifestLeafId(id, a, b)`, never
    ///         by the raw id. Keying by raw id would restore CR-01: any address
    ///         could mark a victim's obligation consumed forever for the price
    ///         of one round. Keyed by the bound leaf, an attacker can only ever
    ///         write keys derived from address pairs that signed the round, so a
    ///         poisoning write lands on a key no honest redemption reads.
    ///         Permanent by construction — nothing evicts, expires or rewrites
    ///         an entry, which is precisely what the root ring could not offer.
    mapping(bytes32 => bool) public consumed;

    /// @notice 1-based last-settlement marker: `nonce + 1` is written for every
    ///         participant of an executed round who actually settled something
    ///         — a non-zero delta, or a `ConsumedRef` naming them as a party.
    ///         0 means the address has never settled in any round.
    /// @dev    WR-11: V2 refreshed this for EVERY participant, so an address
    ///         could keep its liveness marker fresh purely by co-signing rounds
    ///         it had no stake in. Attribution is only checkable at all because
    ///         of the CR-01 binding. This raises the price of a keep-alive to a
    ///         cold SSTORE per fabricated ref; it does not make the clock
    ///         unforgeable (see the contract-level residual note).
    mapping(address => uint64) public lastRound;

    /// @notice Redemption nullifier set, keyed by the IOU id — which IS
    ///         hashIou(iou), the same EIP-712 digest the debtor signed (D-13).
    ///         A redeemed id can never appear in a later round's manifest.
    /// @dev    Deliberately keyed by the RAW id, unlike `consumed`. Only a
    ///         successful `redeemIOU` writes here and that requires the debtor's
    ///         own signature, so no attacker can poison it; keying by raw id is
    ///         then strictly the more conservative choice, because it blocks the
    ///         id under EVERY pairing rather than just the honest one. No
    ///         legitimate round loses anything: `id` is `hashIou`, which already
    ///         fixes both parties, so the honest pairing is the only meaningful
    ///         one.
    mapping(bytes32 => bool) public redeemed;

    /// @notice Staleness gate: a debtor becomes redeemable-against after being
    ///         absent from the last >= K executed rounds. UNCALIBRATED default
    ///         of 3 — proper calibration against round cadence is deferred to
    ///         Phase 3 (D-08).
    uint64 public immutable K;

    bytes32 private constant IOU_TYPEHASH = keccak256(
        "IOU(address debtor,address creditor,uint256 amount,uint256 nonce,uint64 expiry,bytes32 ref)"
    );

    event Deposited(address indexed participant, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed participant, uint256 amount, uint256 newBalance);
    event RoundExecuted(
        uint64 indexed roundNonce,
        bytes32 indexed roundHash,
        bytes32 manifestHash,
        uint256 participantCount,
        uint256 settledVolume
    );
    event PositionSettled(
        uint64 indexed roundNonce, address indexed participant, int256 delta, uint256 newCollateral
    );
    event IouRedeemed(
        bytes32 indexed id,
        address indexed debtor,
        address indexed creditor,
        uint256 amount,
        uint64 atRoundNonce
    );

    error LengthMismatch();
    error TooFewParticipants();
    error ParticipantsNotStrictlyAscending();
    error WrongRoundNonce(uint64 expected, uint64 provided);
    error BadSignature(uint256 index);
    error DeltasDoNotSumToZero(int256 sum);
    error InsufficientCollateral(address participant, uint256 balance, uint256 required);
    error InsufficientWithdrawBalance();
    error ZeroAmount();
    error BadConfig();
    error NullifiedIdInManifest(bytes32 id);
    error DebtorNotStale(uint64 lastRound, uint64 requiredStaleness);
    error BadIouSignature();
    error AlreadyRedeemed(bytes32 id);
    error SelfIou();

    // --- new in V3 ---

    /// @notice A ConsumedRef names a participant index that does not exist.
    error PartyIndexOutOfRange(uint256 refIndex, uint32 partyIdx, uint256 participantCount);
    /// @notice A ConsumedRef names the same participant as both parties; no IOU
    ///         has a single party (`redeemIOU` rejects self-IOUs identically).
    error SelfConsumedRef(uint256 refIndex);
    /// @notice This obligation was already netted by an earlier round (IN-05).
    error AlreadyConsumed(bytes32 leafId);
    /// @notice The IOU was netted by a round, so it cannot also be redeemed.
    error IouAlreadyNetted(bytes32 leafId);
    /// @notice The round neither moves value nor consumes paper.
    error EmptyRound();
    /// @notice Renouncing ownership would make `unpause` unreachable (WR-06).
    error RenounceDisabled();
    /// @notice An IOU names the zero address as a party (IN-04).
    error ZeroAddressParty();

    constructor(IERC20 token_, uint64 k_) EIP712("ArcClearingHub", "1") Ownable(msg.sender) {
        if (k_ == 0) revert BadConfig();
        token = token_;
        K = k_;
    }

    /// @notice Post collateral. Depositing is joining — there is no registry.
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 newBalance = collateral[msg.sender] + amount;
        collateral[msg.sender] = newBalance;
        emit Deposited(msg.sender, amount, newBalance);
    }

    /// @notice Withdraw free collateral. Deliberately NOT pausable: exit is
    ///         always possible. Withdrawing between consent and execution can
    ///         only revert the round in full — never partially settle it.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = collateral[msg.sender];
        if (amount > balance) revert InsufficientWithdrawBalance();
        uint256 newBalance = balance - amount;
        collateral[msg.sender] = newBalance;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, newBalance);
    }

    /// @notice The manifest leaf, and the consumption-ledger key, for one
    ///         consumed IOU: a commitment to the id AND its two parties.
    /// @dev    The pair is ordered canonically (ascending by address) before
    ///         hashing, so the leaf is identical whichever way round the caller
    ///         supplies debtor and creditor. Which of the two is the debtor is
    ///         already fixed by `id` itself — `hashIou` covers both addresses —
    ///         so ordering loses no binding while removing a role-swap footgun.
    ///         `abi.encodePacked` is unambiguous here: all three operands are
    ///         fixed-width (32 + 20 + 20 bytes), so no packing collision exists.
    ///         Public so off-chain implementations can assert encoding parity
    ///         against the chain, exactly like `hashRound` and `hashIou`.
    /// @param id The IOU id, i.e. hashIou(iou).
    /// @param partyA One party of the IOU (debtor or creditor).
    /// @param partyB The other party of the IOU.
    function manifestLeafId(bytes32 id, address partyA, address partyB)
        public
        pure
        returns (bytes32)
    {
        (address lo, address hi) = partyA < partyB ? (partyA, partyB) : (partyB, partyA);
        return keccak256(abi.encodePacked(id, lo, hi));
    }

    /// @notice Whether this exact obligation has already been netted by a round.
    /// @dev    Convenience read for clients holding an `Iou` rather than a leaf.
    function isConsumed(Iou calldata iou) external view returns (bool) {
        return consumed[manifestLeafId(hashIou(iou), iou.debtor, iou.creditor)];
    }

    /// @notice Settle a netting round. Permissionless: authority comes from
    ///         the N signatures, each over the same full-position digest.
    /// @dev    CR-01: `consumed_` is party-bound. Each ref's two participant
    ///         indices must be in range and distinct, and the committed leaf is
    ///         `manifestLeafId(id, participants[a], participants[b])` — so an id
    ///         can only enter the manifest paired with addresses that are
    ///         themselves signing participants of this round. The merkle root is
    ///         still derived ON-CHAIN and still travels into the signed digest,
    ///         so signatures transitively bind the exact leaf set, and calldata
    ///         keeps every round's manifest publicly reconstructible.
    ///
    ///         CR-02: each leaf is written to the permanent `consumed` ledger.
    ///         That is what `redeemIOU` reads, so the exclusivity guarantee no
    ///         longer depends on any bounded history a third party can flush.
    ///         `AlreadyConsumed` makes "one IOU, one settlement" an on-chain
    ///         invariant (IN-05), closing the gap where the same id could appear
    ///         in unlimited round manifests.
    ///
    ///         A round must still extinguish something. A round with an empty
    ///         manifest AND an all-zero delta vector achieves nothing except
    ///         advancing `roundNonce`, which moves every non-participant closer
    ///         to being redeemable-against; it is rejected. An all-zero delta
    ///         vector WITH a non-empty manifest stays legal — a round in which
    ///         every participant's flows cancel exactly is a legitimate, and in
    ///         fact the ideal, netting outcome, and blocking it would leave
    ///         genuinely-cancelled paper redeemable.
    ///
    ///         WR-11: `lastRound` is refreshed only for participants who
    ///         actually settled — a non-zero delta or a ref naming them. The
    ///         delta disjunct matters: a round may legitimately move value with
    ///         an empty manifest, and those participants must not be recorded as
    ///         idle.
    /// @param nonce_ Must equal the current `roundNonce` (cross-round replay guard).
    /// @param participants Strictly ascending addresses (canonical order, no duplicates).
    /// @param deltas Net position per participant in token base units; must sum to zero.
    ///        Negative = net debtor (collateral decreases), positive = net creditor.
    ///        Zero is valid: a participant whose flows cancelled still consents,
    ///        which is what extinguishes their netted paper.
    /// @param consumed_ The IOUs this round nets, each bound to its two parties.
    ///        Must be strictly ascending BY DERIVED LEAF — i.e. by
    ///        `manifestLeafId(id, partyA, partyB)`, NOT by raw id — because that
    ///        is what `ManifestMerkle.rootOf` receives. Any already-redeemed id,
    ///        or any leaf already netted by an earlier round, reverts.
    /// @param signatures signatures[i] is participants[i]'s consent over the round digest.
    function executeRound(
        uint64 nonce_,
        address[] calldata participants,
        int256[] calldata deltas,
        ConsumedRef[] calldata consumed_,
        bytes[] calldata signatures
    ) external whenNotPaused nonReentrant {
        if (nonce_ != roundNonce) revert WrongRoundNonce(roundNonce, nonce_);
        uint256 n = participants.length;
        if (n < 2) revert TooFewParticipants();
        if (deltas.length != n || signatures.length != n) revert LengthMismatch();

        uint256 m = consumed_.length;

        // Reject the do-nothing round before any keccak or ecrecover work. Only
        // reached when the manifest is empty, so honest rounds that carry paper
        // never pay for this scan.
        if (m == 0) {
            bool anyNonZero;
            for (uint256 i; i < n; ++i) {
                if (deltas[i] != 0) {
                    anyNonZero = true;
                    break;
                }
            }
            if (!anyNonZero) revert EmptyRound();
        }

        // CR-01: derive the party-bound leaf of every consumed IOU. Both
        // exclusivity gates run in the same pass and before any signature work:
        // a redeemed IOU's paper is extinguished (D-14 on-chain half), and an
        // already-netted leaf can never be netted twice (IN-05).
        bytes32[] memory leaves = new bytes32[](m);
        bool[] memory settled = new bool[](n); // WR-11 attribution
        for (uint256 i; i < m; ++i) {
            ConsumedRef calldata ref = consumed_[i];
            if (ref.partyAIdx >= n) revert PartyIndexOutOfRange(i, ref.partyAIdx, n);
            if (ref.partyBIdx >= n) revert PartyIndexOutOfRange(i, ref.partyBIdx, n);
            if (ref.partyAIdx == ref.partyBIdx) revert SelfConsumedRef(i);
            if (redeemed[ref.id]) revert NullifiedIdInManifest(ref.id);
            bytes32 leaf =
                manifestLeafId(ref.id, participants[ref.partyAIdx], participants[ref.partyBIdx]);
            if (consumed[leaf]) revert AlreadyConsumed(leaf);
            leaves[i] = leaf;
            settled[ref.partyAIdx] = true;
            settled[ref.partyBIdx] = true;
        }

        // rootOf's UnsortedLeaves revert is the sorted-manifest guard. It orders
        // DERIVED leaves, which also makes duplicate entries within one manifest
        // impossible.
        bytes32 root = ManifestMerkle.rootOf(leaves);

        bytes32 digest = hashRound(nonce_, participants, deltas, root);

        int256 sum;
        address prev;
        for (uint256 i; i < n; ++i) {
            address p = participants[i];
            if (p <= prev) revert ParticipantsNotStrictlyAscending();
            prev = p;
            if (ECDSA.recover(digest, signatures[i]) != p) revert BadSignature(i);
            sum += deltas[i];
        }
        if (sum != 0) revert DeltasDoNotSumToZero(sum);

        // Effects: the ledger is written only once the round is fully consented
        // to and structurally valid.
        for (uint256 i; i < m; ++i) {
            consumed[leaves[i]] = true;
        }

        uint256 settledVolume;
        for (uint256 i; i < n; ++i) {
            address p = participants[i];
            int256 delta = deltas[i];
            uint256 balance = collateral[p];
            uint256 newBalance;
            if (delta < 0) {
                uint256 debit = uint256(-delta);
                if (balance < debit) revert InsufficientCollateral(p, balance, debit);
                newBalance = balance - debit;
            } else {
                settledVolume += uint256(delta);
                newBalance = balance + uint256(delta);
            }
            collateral[p] = newBalance;
            // WR-11: only participants who actually settled something refresh
            // their liveness marker. Co-signing alone is not participation.
            if (settled[i] || delta != 0) lastRound[p] = nonce_ + 1;
            emit PositionSettled(nonce_, p, delta, newBalance);
        }

        roundNonce = nonce_ + 1;
        emit RoundExecuted(nonce_, digest, root, n, settledVolume);
    }

    /// @notice Redeem an unnetted IOU against an unresponsive debtor's
    ///         collateral: debits the debtor by the full amount, credits the
    ///         creditor, and nullifies the id so no later round can net it.
    ///         Permissionless — a relayer can submit; funds only ever credit
    ///         the IOU's named creditor.
    /// @dev    The staleness gate is the on-chain criterion "absent from the
    ///         last >= K executed rounds", i.e. `roundNonce - lastRound[iou.debtor] >= K`
    ///         — NOT coordinator wall-clock consent windows, which are only an
    ///         off-chain early-warning signal (D-09). With `lastRound` 1-based,
    ///         a never-settled debtor (lastRound == 0) is stale once
    ///         `roundNonce >= K`.
    ///
    ///         Exclusivity is now a single O(1) storage read. The IOU is
    ///         redeemable iff no round ever netted its party-bound leaf; that
    ///         fact is permanent and cannot be manufactured by a third party,
    ///         because writing the honest leaf requires both parties to sign the
    ///         round that writes it. V2's non-inclusion proof set, root ring and
    ///         `expiry - L` coverage precondition are all gone: there is nothing
    ///         left to flush, nothing to buffer, and no TOCTOU window, so a
    ///         redemption can no longer be invalidated by a round landing
    ///         between proof generation and mining.
    ///
    ///         There is deliberately NO block.timestamp-vs-expiry check —
    ///         expiry bounds netting, not recovery; redemption stays valid after
    ///         expiry (D-07d).
    ///
    ///         Redemption is best-effort recovery of posted, still-present
    ///         collateral — it races the deliberately never-pausable `withdraw`
    ///         by design; there is no lock and must not be one. `whenNotPaused`
    ///         gives circuit-breaker parity with `executeRound` (redemption is a
    ///         settlement op); the exit guarantee lives solely in `withdraw`,
    ///         which no pause touches.
    /// @param iou The obligation exactly as the debtor signed it (hashIou is the id).
    /// @param sig The debtor's EIP-712 signature over hashIou(iou).
    function redeemIOU(Iou calldata iou, bytes calldata sig)
        external
        whenNotPaused
        nonReentrant
    {
        // (0) trivia gates
        if (iou.amount == 0) revert ZeroAmount();
        if (iou.debtor == iou.creditor) revert SelfIou();
        // IN-04: crediting the zero address would burn the debtor's collateral.
        if (iou.debtor == address(0) || iou.creditor == address(0)) revert ZeroAddressParty();

        uint64 nonce_ = roundNonce;

        // (1) staleness: absent from the last >= K executed rounds, i.e.
        //     roundNonce - lastRound[debtor] >= K (additive form, no underflow;
        //     never-settled debtors are stale once roundNonce >= K).
        uint64 seen = lastRound[iou.debtor];
        if (nonce_ < seen + K) revert DebtorNotStale(seen, K);

        // (2) debtor consent: the signature is over the same digest that is the id.
        bytes32 id = hashIou(iou);
        if (ECDSA.recover(id, sig) != iou.debtor) revert BadIouSignature();

        // (3) nullifier
        if (redeemed[id]) revert AlreadyRedeemed(id);

        // (4) exclusivity (CR-02): net -> cannot-redeem, as one permanent read.
        bytes32 leaf = manifestLeafId(id, iou.debtor, iou.creditor);
        if (consumed[leaf]) revert IouAlreadyNetted(leaf);

        // (5) effects: nullify, move collateral debtor -> creditor in full
        //     (no partial redemption — the nullifier is boolean). Hub token
        //     balance untouched: collateral conservation, same as rounds.
        redeemed[id] = true;
        uint256 balance = collateral[iou.debtor];
        if (balance < iou.amount) {
            revert InsufficientCollateral(iou.debtor, balance, iou.amount);
        }
        collateral[iou.debtor] = balance - iou.amount;
        collateral[iou.creditor] += iou.amount;
        emit IouRedeemed(id, iou.debtor, iou.creditor, iou.amount, nonce_);
    }

    /// @notice EIP-712 digest every participant signs. Public so off-chain
    ///         implementations can assert encoding parity against the chain.
    /// @dev    Byte-identical to V1/V2 — the shared digest fixture still applies.
    function hashRound(
        uint64 nonce_,
        address[] calldata participants,
        int256[] calldata deltas,
        bytes32 manifestHash
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ROUND_TYPEHASH,
                    nonce_,
                    keccak256(abi.encodePacked(participants)),
                    keccak256(abi.encodePacked(deltas)),
                    manifestHash
                )
            )
        );
    }

    /// @notice EIP-712 digest of an IOU — the canonical IOU id, byte-equal to
    ///         the SDK's iouId and to what the debtor signed. Public so
    ///         off-chain implementations can assert encoding parity against
    ///         the chain (and so reads like `redeemed[hashIou(iou)]` compose).
    function hashIou(Iou calldata iou) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    IOU_TYPEHASH,
                    iou.debtor,
                    iou.creditor,
                    iou.amount,
                    iou.nonce,
                    iou.expiry,
                    iou.ref
                )
            )
        );
    }

    /// @notice Circuit breaker for deposits and rounds. Withdrawals are never
    ///         pausable, so funds can never be trapped.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled by design (WR-06). `Ownable2Step` overrides
    ///         `transferOwnership` but NOT `renounceOwnership`; renouncing while
    ///         the hub is paused would make `unpause` permanently unreachable,
    ///         killing deposits, rounds and redemption forever. Withdrawal would
    ///         survive, so funds could not be trapped — but the protocol would
    ///         be dead. Ownership can still be handed to a multisig or timelock
    ///         via the two-step transfer.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
