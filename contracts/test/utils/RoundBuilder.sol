// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ClearingHub} from "../../src/ClearingHub.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test harness: known-key actors, sorted-round assembly, consent signing.
abstract contract RoundBuilder is Test {
    ClearingHub internal hub;
    MockUSDC internal usdc;

    uint256 internal constant ACTORS = 5;
    uint256[] internal keys;
    address[] internal actors; // sorted ascending by address

    function _setUpActors() internal {
        usdc = new MockUSDC();
        hub = new ClearingHub(usdc);

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

    function _fundAndDeposit(address actor, uint256 amount) internal {
        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(hub), amount);
        hub.deposit(amount);
        vm.stopPrank();
    }

    function _keyOf(address actor) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == actor) return keys[i];
        }
        revert("unknown actor");
    }

    function _signRound(
        uint256 pk,
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32 manifestHash
    ) internal view returns (bytes memory) {
        bytes32 digest = _digest(nonce_, participants, deltas, manifestHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Mirrors ClearingHub.hashRound for memory arrays (hub takes calldata).
    function _digest(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32 manifestHash
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Round(uint64 roundNonce,address[] participants,int256[] deltas,bytes32 manifestHash)"
                ),
                nonce_,
                keccak256(abi.encodePacked(participants)),
                keccak256(abi.encodePacked(deltas)),
                manifestHash
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ArcClearingHub")),
                keccak256(bytes("1")),
                block.chainid,
                address(hub)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @dev Build a fully signed round from (participants, deltas).
    function _buildSignatures(
        uint64 nonce_,
        address[] memory participants,
        int256[] memory deltas,
        bytes32 manifestHash
    ) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](participants.length);
        for (uint256 i; i < participants.length; ++i) {
            sigs[i] = _signRound(_keyOf(participants[i]), nonce_, participants, deltas, manifestHash);
        }
    }
}
