// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
/// @dev    Near-verbatim copy of ClearingHub.sol: same EIP-712 domain
///         ("ArcClearingHub", "1"), same ROUND_TYPEHASH, same errors, events,
///         and checks — digest parity with the v1 fixture is machine-checked
///         in ClearingHubV2Parity.t.sol. `manifestHash` carries the keccak256
///         of the sorted consumed-IOU-id list (same bytes32 slot as v1; a
///         later phase swaps in a sorted-leaf merkle root without touching
///         the contract). No owner access to funds, no upgradeability, no
///         fees; `pause` gates deposits and rounds but never withdrawal.
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

    error LengthMismatch();
    error TooFewParticipants();
    error ParticipantsNotStrictlyAscending();
    error WrongRoundNonce(uint64 expected, uint64 provided);
    error BadSignature(uint256 index);
    error DeltasDoNotSumToZero(int256 sum);
    error InsufficientCollateral(address participant, uint256 balance, uint256 required);
    error InsufficientWithdrawBalance();
    error ZeroAmount();

    constructor(IERC20 token_) EIP712("ArcClearingHub", "1") Ownable(msg.sender) {
        token = token_;
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
    /// @param manifestHash keccak256 of the sorted consumed-IOU-id list.
    /// @param signatures signatures[i] is participants[i]'s consent over the round digest.
    function executeRound(
        uint64 nonce_,
        address[] calldata participants,
        int256[] calldata deltas,
        bytes32 manifestHash,
        bytes[] calldata signatures
    ) external whenNotPaused nonReentrant {
        if (nonce_ != roundNonce) revert WrongRoundNonce(roundNonce, nonce_);
        uint256 n = participants.length;
        if (n < 2) revert TooFewParticipants();
        if (deltas.length != n || signatures.length != n) revert LengthMismatch();

        bytes32 digest = hashRound(nonce_, participants, deltas, manifestHash);

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
            emit PositionSettled(nonce_, p, delta, newBalance);
        }

        roundNonce = nonce_ + 1;
        emit RoundExecuted(nonce_, digest, manifestHash, n, settledVolume);
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

    /// @notice Circuit breaker for deposits and rounds. Withdrawals are never
    ///         pausable, so funds can never be trapped.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
