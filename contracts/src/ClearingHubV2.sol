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

/// @title ClearingHubV2 — multilateral obligation netting for one ERC-20 (Arclear Net v2)
/// @notice v2 settlement contract for the threshold-consent protocol. The
///         entire threshold mechanism — exclude-and-recompute over the
///         candidate set, two-pass consent collection — lives OFF-CHAIN in the
///         coordinator/SDK. On-chain, the execution path is identical to v1:
///         a round executes only with a valid EIP-712 signature from EVERY
///         listed participant over one shared digest of the full position set
///         (unanimity over the final executed set). A coordinator may assemble
///         rounds but holds no authority: it cannot forge consent, and
///         `executeRound` is permissionless given the signatures.
/// @dev    Same EIP-712 domain as v1 ("ArcClearingHub", "1"), same
///         ROUND_TYPEHASH, same errors, events, and checks on the round path —
///         digest parity with the v1 fixture is machine-checked in
///         ClearingHubV2Parity.t.sol. `manifestHash` (the same bytes32 slot in
///         the signed Round struct as v1) now carries the sorted-leaf merkle
///         root of the consumed-IOU-id manifest, derived ON-CHAIN from the
///         `consumedIds` calldata via ManifestMerkle.rootOf — so signatures
///         transitively bind the exact id list, and every round's leaf set is
///         permanently reconstructible from calldata. On top of netting, the
///         hub tracks per-participant liveness (`lastRound`), a ring buffer of
///         recent manifest roots (`rootRing`), and a redemption nullifier set
///         (`redeemed`) enabling `redeemIOU` recovery against unresponsive
///         debtors. No owner access to funds, no upgradeability, no fees;
///         `pause` gates deposits, rounds, and redemptions but never
///         withdrawal.
contract ClearingHubV2 is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
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
    // v2 redemption state — appended AFTER all v1-parity declarations so
    // the storage layout stays diffable against v1 for audit purposes.
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

    /// @notice A buffered round root: the manifest merkle root plus the nonce
    ///         and timestamp of the round that committed it.
    struct StoredRoot {
        bytes32 root;
        uint64 nonce;
        uint64 executedAt;
    }

    /// @notice Ring buffer of the last RING executed rounds' manifest roots,
    ///         keyed by `nonce % RING`. Redemption verifies non-inclusion
    ///         against every buffered root.
    mapping(uint256 => StoredRoot) public rootRing;

    /// @notice 1-based last-participation marker: `nonce + 1` is written for
    ///         EVERY participant of an executed round (zero-delta consenters
    ///         included — their netted paper was consumed, participation is
    ///         consent). 0 means the address never participated in any round.
    mapping(address => uint64) public lastRound;

    /// @notice Redemption nullifier set, keyed by the IOU id — which IS
    ///         hashIou(iou), the same EIP-712 digest the debtor signed (D-13).
    ///         A redeemed id can never appear in a later round's manifest.
    mapping(bytes32 => bool) public redeemed;

    /// @notice Staleness gate: a debtor becomes redeemable-against after being
    ///         absent from the last >= K executed rounds. UNCALIBRATED default
    ///         of 3 — proper calibration against round cadence is deferred to
    ///         Phase 3 (D-08).
    uint64 public immutable K;

    /// @notice Root-ring size: how many recent rounds' manifest roots stay
    ///         verifiable on-chain. UNCALIBRATED default of 16 — the
    ///         K/RING/cadence trade-off is deferred to Phase 3 (D-08).
    uint64 public immutable RING;

    /// @notice "L": the SDK signing convention bounds every IOU's expiry to
    ///         signTime + L (enforced off-chain in signIou), so every round
    ///         that could have consumed an IOU executed inside
    ///         [expiry - L, expiry). UNCALIBRATED default of 86400 seconds —
    ///         calibration against ring depth and cadence is deferred to
    ///         Phase 3 (D-08, D-15 coverage rule).
    uint64 public immutable MAX_IOU_LIFETIME;

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
    error CoverageWindowNotBuffered(uint64 oldestExecutedAt, uint64 windowStart);
    error BadIouSignature();
    error AlreadyRedeemed(bytes32 id);
    error ProofCountMismatch(uint256 expected, uint256 provided);
    error NonInclusionProofInvalid(uint64 roundNonce);
    error SelfIou();

    constructor(IERC20 token_, uint64 k_, uint64 ring_, uint64 maxIouLifetime_)
        EIP712("ArcClearingHub", "1")
        Ownable(msg.sender)
    {
        if (k_ == 0 || ring_ == 0 || maxIouLifetime_ == 0) revert BadConfig();
        token = token_;
        K = k_;
        RING = ring_;
        MAX_IOU_LIFETIME = maxIouLifetime_;
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

    /// @notice Settle a netting round. Permissionless: authority comes from
    ///         the N signatures, each over the same full-position digest.
    /// @param nonce_ Must equal the current `roundNonce` (cross-round replay guard).
    /// @param participants Strictly ascending addresses (canonical order, no duplicates).
    /// @param deltas Net position per participant in token base units; must sum to zero.
    ///        Negative = net debtor (collateral decreases), positive = net creditor.
    ///        Zero is valid: a participant whose flows cancelled still consents,
    ///        which is what extinguishes their netted paper.
    /// @param consumedIds strictly-ascending unique IOU ids consumed by this
    ///        round; the manifest merkle root is derived on-chain so signatures
    ///        transitively bind the exact id list, and calldata makes every
    ///        round's leaf set publicly reconstructible. Any already-redeemed
    ///        id reverts the round (the on-chain half of redeem->cannot-net).
    /// @param signatures signatures[i] is participants[i]'s consent over the round digest.
    function executeRound(
        uint64 nonce_,
        address[] calldata participants,
        int256[] calldata deltas,
        bytes32[] calldata consumedIds,
        bytes[] calldata signatures
    ) external whenNotPaused nonReentrant {
        if (nonce_ != roundNonce) revert WrongRoundNonce(roundNonce, nonce_);
        uint256 n = participants.length;
        if (n < 2) revert TooFewParticipants();
        if (deltas.length != n || signatures.length != n) revert LengthMismatch();

        // Nullifier gate before any signature work: a redeemed IOU's paper is
        // extinguished — no round may net it again (D-14 on-chain half).
        uint256 m = consumedIds.length;
        for (uint256 i; i < m; ++i) {
            if (redeemed[consumedIds[i]]) revert NullifiedIdInManifest(consumedIds[i]);
        }

        // rootOf's UnsortedLeaves revert is the sorted-manifest guard.
        bytes32 root = ManifestMerkle.rootOf(consumedIds);

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
            // 1-based participation marker for EVERY participant — zero-delta
            // consenters' netted paper was consumed, so they participated.
            lastRound[p] = nonce_ + 1;
            emit PositionSettled(nonce_, p, delta, newBalance);
        }

        // `% RING` is ring-buffer index arithmetic, not protocol-value math.
        rootRing[nonce_ % RING] = StoredRoot(root, nonce_, uint64(block.timestamp));

        roundNonce = nonce_ + 1;
        emit RoundExecuted(nonce_, digest, root, n, settledVolume);
    }

    /// @notice Redeem an unconsumed IOU against an unresponsive debtor's
    ///         collateral: debits the debtor by the full amount, credits the
    ///         creditor, and nullifies the id so no later round can net it.
    ///         Permissionless — a relayer can submit; funds only ever credit
    ///         the IOU's named creditor.
    /// @dev    The staleness gate is the on-chain criterion "absent from the
    ///         last >= K executed rounds", i.e. `roundNonce - lastRound[iou.debtor] >= K`
    ///         — NOT coordinator wall-clock consent windows, which are only an
    ///         off-chain early-warning signal (D-09). With `lastRound` 1-based,
    ///         a never-participated debtor (lastRound == 0) is stale once
    ///         `roundNonce >= K`: they have ignored every executed round that
    ///         ever existed.
    ///
    ///         Coverage precondition (D-15): if `roundNonce <= RING`, no root
    ///         was ever evicted and the full history is verifiable. Otherwise
    ///         the oldest buffered round must have executed strictly before
    ///         `expiry - MAX_IOU_LIFETIME`. Safety argument: under the SDK
    ///         signing convention `expiry <= signTime + L` (with the netting
    ///         engine's 60s safety window assumed to cover proposal-to-execution
    ///         latency), any round consuming this IOU executed inside
    ///         [expiry - L, expiry) — so when the oldest buffered root predates
    ///         `expiry - L`, every possible consuming round is still buffered
    ///         and the proof set is complete for honest debtors. A debtor who
    ///         violates the convention weakens only their own double-claim
    ///         protection (only the debtor signs IOUs, and redemption only
    ///         debits the debtor). Fail-closed: `expiry <= L` with evicted
    ///         history can never satisfy the window (the would-be underflow
    ///         branch reverts). There is deliberately NO block.timestamp-vs-
    ///         expiry check — expiry bounds netting, not recovery; redemption
    ///         stays valid after expiry (D-07d).
    ///
    ///         The contract derives the required proof set itself: exactly one
    ///         non-inclusion proof per buffered round, positionally matched to
    ///         ascending nonces — a prover can never choose which roots to
    ///         answer for. If a round lands between proof generation and this
    ///         call being mined, `roundNonce` moves, so the count/positional
    ///         match fails and the call reverts; the creditor simply
    ///         regenerates proofs (TOCTOU-safe: no silently uncovered round).
    ///
    ///         Redemption is best-effort recovery of posted, still-present
    ///         collateral — it races the deliberately never-pausable
    ///         `withdraw` by design; there is no lock and must not be one.
    ///         `whenNotPaused` gives circuit-breaker parity with
    ///         `executeRound` (redemption is a settlement op); the exit
    ///         guarantee lives solely in `withdraw`, which no pause touches.
    /// @param iou The obligation exactly as the debtor signed it (hashIou is the id).
    /// @param sig The debtor's EIP-712 signature over hashIou(iou).
    /// @param proofs One non-inclusion proof per buffered round, ascending by
    ///        round nonce; sentinel (empty-manifest) roots pass structurally.
    function redeemIOU(
        Iou calldata iou,
        bytes calldata sig,
        ManifestMerkle.NonInclusionProof[] calldata proofs
    ) external whenNotPaused nonReentrant {
        // (0) trivia gates
        if (iou.amount == 0) revert ZeroAmount();
        if (iou.debtor == iou.creditor) revert SelfIou();

        uint64 nonce_ = roundNonce;

        // (1) staleness: absent from the last >= K executed rounds, i.e.
        //     roundNonce - lastRound[debtor] >= K (additive form, no underflow;
        //     never-participated debtors are stale once roundNonce >= K).
        uint64 seen = lastRound[iou.debtor];
        if (nonce_ < seen + K) revert DebtorNotStale(seen, K);

        // (2) coverage (D-15): full history buffered, or every possible
        //     consuming round still buffered. Explicit underflow guard on
        //     expiry - L keeps the evicted+short-lived case fail-closed.
        if (nonce_ > RING) {
            uint64 oldestExecutedAt = rootRing[(nonce_ - RING) % RING].executedAt;
            uint64 windowStart = iou.expiry > MAX_IOU_LIFETIME ? iou.expiry - MAX_IOU_LIFETIME : 0;
            if (iou.expiry <= MAX_IOU_LIFETIME || oldestExecutedAt >= windowStart) {
                revert CoverageWindowNotBuffered(oldestExecutedAt, windowStart);
            }
        }

        // (3) debtor consent: the signature is over the same digest that is the id.
        bytes32 id = hashIou(iou);
        if (ECDSA.recover(id, sig) != iou.debtor) revert BadIouSignature();

        // (4) nullifier
        if (redeemed[id]) revert AlreadyRedeemed(id);

        // (5) contract-derived proof regime: exactly one proof per buffered
        //     round, positionally matched to ascending nonces (Pitfall 5).
        uint256 expected = nonce_ < RING ? nonce_ : RING;
        if (proofs.length != expected) revert ProofCountMismatch(expected, proofs.length);
        uint64 start = nonce_ > RING ? nonce_ - RING : 0;
        for (uint256 i; i < expected; ++i) {
            // `% RING` is ring-buffer index arithmetic, not protocol-value math.
            uint64 bufferedNonce = start + uint64(i);
            bytes32 root = rootRing[bufferedNonce % RING].root;
            if (!ManifestMerkle.verifyNonInclusion(id, proofs[i], root)) {
                revert NonInclusionProofInvalid(bufferedNonce);
            }
        }

        // (6) effects: nullify, move collateral debtor -> creditor in full
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
}
