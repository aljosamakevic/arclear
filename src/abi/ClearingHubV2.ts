/** ABI + creation bytecode for ClearingHubV2, pasted from contracts/out after `forge build`. */
export const clearingHubV2Abi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "token_",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "k_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "ring_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "maxIouLifetime_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "K",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_IOU_LIFETIME",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "RING",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "collateral",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "eip712Domain",
    "inputs": [],
    "outputs": [
      {
        "name": "fields",
        "type": "bytes1",
        "internalType": "bytes1"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "chainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "verifyingContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "extensions",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "executeRound",
    "inputs": [
      {
        "name": "nonce_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "participants",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "deltas",
        "type": "int256[]",
        "internalType": "int256[]"
      },
      {
        "name": "consumedIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      },
      {
        "name": "signatures",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "hashIou",
    "inputs": [
      {
        "name": "iou",
        "type": "tuple",
        "internalType": "struct ClearingHubV2.Iou",
        "components": [
          {
            "name": "debtor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "creditor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "ref",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashRound",
    "inputs": [
      {
        "name": "nonce_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "participants",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "deltas",
        "type": "int256[]",
        "internalType": "int256[]"
      },
      {
        "name": "manifestHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "lastRound",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "redeemIOU",
    "inputs": [
      {
        "name": "iou",
        "type": "tuple",
        "internalType": "struct ClearingHubV2.Iou",
        "components": [
          {
            "name": "debtor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "creditor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "ref",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "sig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "proofs",
        "type": "tuple[]",
        "internalType": "struct ManifestMerkle.NonInclusionProof[]",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum ManifestMerkle.NonInclusionKind"
          },
          {
            "name": "a",
            "type": "tuple",
            "internalType": "struct ManifestMerkle.InclusionProof",
            "components": [
              {
                "name": "leaf",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "index",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "leafCount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "siblings",
                "type": "bytes32[]",
                "internalType": "bytes32[]"
              }
            ]
          },
          {
            "name": "b",
            "type": "tuple",
            "internalType": "struct ManifestMerkle.InclusionProof",
            "components": [
              {
                "name": "leaf",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "index",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "leafCount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "siblings",
                "type": "bytes32[]",
                "internalType": "bytes32[]"
              }
            ]
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "redeemed",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "rootRing",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "root",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "executedAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "roundNonce",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "token",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "unpause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Deposited",
    "inputs": [
      {
        "name": "participant",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newBalance",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EIP712DomainChanged",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "IouRedeemed",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "debtor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "creditor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "atRoundNonce",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Paused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionSettled",
    "inputs": [
      {
        "name": "roundNonce",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "participant",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "delta",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "newCollateral",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundExecuted",
    "inputs": [
      {
        "name": "roundNonce",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "roundHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "manifestHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "participantCount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "settledVolume",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Unpaused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdrawn",
    "inputs": [
      {
        "name": "participant",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newBalance",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyRedeemed",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "BadConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadIouSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "CoverageWindowNotBuffered",
    "inputs": [
      {
        "name": "oldestExecutedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "windowStart",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "DebtorNotStale",
    "inputs": [
      {
        "name": "lastRound",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "requiredStaleness",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "DeltasDoNotSumToZero",
    "inputs": [
      {
        "name": "sum",
        "type": "int256",
        "internalType": "int256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignatureLength",
    "inputs": [
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ECDSAInvalidSignatureS",
    "inputs": [
      {
        "name": "s",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "EnforcedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpectedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientCollateral",
    "inputs": [
      {
        "name": "participant",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "required",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InsufficientWithdrawBalance",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LengthMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonInclusionProofInvalid",
    "inputs": [
      {
        "name": "roundNonce",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NullifiedIdInManifest",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ParticipantsNotStrictlyAscending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ProofCountMismatch",
    "inputs": [
      {
        "name": "expected",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "provided",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SelfIou",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "TooFewParticipants",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsortedLeaves",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "WrongRoundNonce",
    "inputs": [
      {
        "name": "expected",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "provided",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;

export const clearingHubV2Bytecode = "0x6101e080604052346102c457608081613512803803809161002082856102c8565b8339810103126102c4578051906001600160a01b03821682036102c457610049602082016102ff565b90610062606061005b604084016102ff565b92016102ff565b916040516100716040826102c8565b600e815260208101906d20b931a1b632b0b934b733a43ab160911b82526040519161009d6040846102c8565b600183526020830191603160f81b83526100b681610313565b610120526100c3846104a9565b61014052519020918260e05251902080610100524660a0526040519060208201927f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8452604083015260608201524660808201523060a082015260a0815261012c60c0826102c8565b5190206080523060c05233156102b157600380546001600160a01b0319908116909155600280549182163390811790915560405195916001600160a01b03167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e05f80a360017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00556001600160401b0382161580156102a0575b801561028f575b6102805761016052610180526101a0526101c052612f3090816105e2823960805181612b3a015260a05181612bf7015260c05181612b0b015260e05181612b8901526101005181612baf01526101205181610de201526101405181610e0b0152610160518181816101d10152818161034e01526114c901526101805181818161050801526116fa01526101a05181818161015f01528181610833015261173801526101c0518181816114370152611bb30152f35b6301f30c8760e21b5f5260045ffd5b506001600160401b038416156101cc565b506001600160401b038316156101c5565b631e4fbdf760e01b5f525f60045260245ffd5b5f80fd5b601f909101601f19168101906001600160401b038211908210176102eb57604052565b634e487b7160e01b5f52604160045260245ffd5b51906001600160401b03821682036102c457565b908151602081105f1461038d575090601f81511161034d57602081519101516020821061033e571790565b5f198260200360031b1b161790565b604460209160405192839163305a27a960e01b83528160048401528051918291826024860152018484015e5f828201840152601f01601f19168101030190fd5b6001600160401b0381116102eb575f54600181811c9116801561049f575b602082101461048b57601f8111610459575b50602092601f82116001146103fa57928192935f926103ef575b50508160011b915f199060031b1c1916175f5560ff90565b015190505f806103d7565b601f198216935f8052805f20915f5b8681106104415750836001959610610429575b505050811b015f5560ff90565b01515f1960f88460031b161c191690555f808061041c565b91926020600181928685015181550194019201610409565b5f8052601f60205f20910160051c810190601f830160051c015b81811061048057506103bd565b5f8155600101610473565b634e487b7160e01b5f52602260045260245ffd5b90607f16906103ab565b908151602081105f146104d4575090601f81511161034d57602081519101516020821061033e571790565b6001600160401b0381116102eb57600154600181811c911680156105d7575b602082101461048b57601f81116105a4575b50602092601f821160011461054357928192935f92610538575b50508160011b915f199060031b1c19161760015560ff90565b015190505f8061051f565b601f1982169360015f52805f20915f5b86811061058c5750836001959610610574575b505050811b0160015560ff90565b01515f1960f88460031b161c191690555f8080610566565b91926020600181928685015181550194019201610553565b60015f52601f60205f20910160051c810190601f830160051c015b8181106105cc5750610505565b5f81556001016105bf565b90607f16906104f356fe60a06040526004361015610011575f80fd5b5f3560e01c80631debb337146115d35780632e1a7d4d1461145b57806332c028f6146113f95780633d8b9e07146113ac5780633f4ba83a146112ee578063415a1b86146112a65780635c975abb1461126357806361f6b445146111f65780636d684f621461118e578063715018a6146110ca57806379ba509714610fc057806382de6d1714610f875780638456cb5914610ede57806384b0196e14610dac5780638bdfbdc2146106745780638da5cb5b14610623578063a023226b1461058f578063a5fdc5de1461052c578063a932492f146104ca578063b6b55f2514610304578063e30c3978146102b3578063f2fde38b146101f5578063fc0c546a146101875763ff37656e14610121575f80fd5b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602060405167ffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b5f80fd5b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602060405173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b346101835760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101835773ffffffffffffffffffffffffffffffffffffffff610241611d03565b61024961252c565b16807fffffffffffffffffffffffff0000000000000000000000000000000000000000600354161760035573ffffffffffffffffffffffffffffffffffffffff600254167f38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e227005f80a3005b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602073ffffffffffffffffffffffffffffffffffffffff60035416604051908152f35b346101835760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101835760043561033e6122c4565b6103466122fb565b80156104a2577f00000000000000000000000000000000000000000000000000000000000000006040517f23b872dd000000000000000000000000000000000000000000000000000000005f5233600452306024528260445260205f60648180865af19060015f5114821615610481575b6040525f6060521561043f5750335f5260046020526103da8160405f205461208a565b335f5260046020528060405f205560405191825260208201527f73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca60403392a260017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b73ffffffffffffffffffffffffffffffffffffffff907f5274afe7000000000000000000000000000000000000000000000000000000005f521660045260245ffd5b90600181151661049957823b15153d151616906103b7565b503d5f823e3d90fd5b7f1f2a2005000000000000000000000000000000000000000000000000000000005f5260045ffd5b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602060405167ffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b346101835760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101835773ffffffffffffffffffffffffffffffffffffffff610578611d03565b165f526004602052602060405f2054604051908152f35b346101835760807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610183576105c6611d69565b60243567ffffffffffffffff8111610183576105e6903690600401611cd2565b90916044359167ffffffffffffffff83116101835760209361060f61061b943690600401611cd2565b92909160643594612177565b604051908152f35b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602073ffffffffffffffffffffffffffffffffffffffff60025416604051908152f35b346101835760a07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610183576106ab611d69565b60243567ffffffffffffffff8111610183576106cb903690600401611cd2565b60443567ffffffffffffffff8111610183576106eb903690600401611cd2565b91909360643567ffffffffffffffff81116101835761070e903690600401611cd2565b94909560843567ffffffffffffffff811161018357610731903690600401611cd2565b909761073b6122c4565b6107436122fb565b67ffffffffffffffff60035460a81c169767ffffffffffffffff861698808a03610d7c575060028710610d5457868814801590610d4a575b610d22575f5b818110610cc5575061079d91610798913691611fb5565b6125a2565b976107ac89888589888a612177565b6080525f915f80927fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe181360301905b898510610b6857505050505080610b3d57505f945f5b85811061098357505050506108d89060405161080c81611eaf565b868152602081019086825267ffffffffffffffff80600160408401938242168552826108587f000000000000000000000000000000000000000000000000000000000000000089611e4b565b165f52600560205260405f209051815501935116167fffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000835416178255517fffffffffffffffffffffffffffffffff0000000000000000ffffffffffffffff6fffffffffffffffff000000000000000083549260401b169116179055611de7565b7fffffff0000000000000000ffffffffffffffffffffffffffffffffffffffffff7cffffffffffffffff0000000000000000000000000000000000000000006003549260a81b16911617600355604051938452602084015260408301527fd75dc2ed4b3b26b1d6e102d58791c1335f8c671dac68f205d0ef6f1408bda10e606060805193a360017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b610996610991828887612167565b611dc6565b73ffffffffffffffffffffffffffffffffffffffff6109b6838587612167565b35911690815f52600460205260405f20548a5f83125f14610afa57507f80000000000000000000000000000000000000000000000000000000000000008214610acd57815f0390818110610a9b5760406001959493610a378e947febdef941328d19c0bb28043197c4705da993b9b302943a4120acfa8bf0960fe59461207d565b855f52600460205280835f2055610a4d8c611de7565b865f52600660205267ffffffffffffffff845f2091167fffffffffffffffffffffffffffffffffffffffffffffffff000000000000000082541617905582519182526020820152a3016107f1565b837f4f4d34e4000000000000000000000000000000000000000000000000000000005f5260045260245260445260645ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b9099604083610b3881610b3260019998977febdef941328d19c0bb28043197c4705da993b9b302943a4120acfa8bf0960fe59661208a565b9e61208a565b610a37565b7faad3b2d3000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b9091929394610b7b610991878c8b612167565b73ffffffffffffffffffffffffffffffffffffffff8082169516851115610c9d579385871015610c70578660051b83013584811215610183578301803567ffffffffffffffff811161018357803603602083011361018357610c05610bfd73ffffffffffffffffffffffffffffffffffffffff93610c0e936020369201611f39565b608051612878565b909291926128b2565b1603610c4457610c1f868c89612167565b35905f8282019283129112908015821691151617610acd5794600101939291906107db565b857fa1c97319000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52603260045260245ffd5b7f181a5518000000000000000000000000000000000000000000000000000000005f5260045ffd5b610cd0818385612167565b355f52600760205260ff60405f205416610cec57600101610781565b90610cf692612167565b357f47833236000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7fff633a38000000000000000000000000000000000000000000000000000000005f5260045ffd5b508683141561077b565b7f7c8babaa000000000000000000000000000000000000000000000000000000005f5260045ffd5b89907fc69cde43000000000000000000000000000000000000000000000000000000005f5260045260245260445ffd5b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357610e82610e067f0000000000000000000000000000000000000000000000000000000000000000612c1d565b610e2f7f0000000000000000000000000000000000000000000000000000000000000000612d90565b6020610e9060405192610e428385611ef8565b5f84525f3681376040519586957f0f00000000000000000000000000000000000000000000000000000000000000875260e08588015260e0870190611d26565b908582036040870152611d26565b4660608501523060808501525f60a085015283810360c08501528180845192838152019301915f5b828110610ec757505050500390f35b835185528695509381019392810192600101610eb8565b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357610f1461252c565b610f1c6122c4565b740100000000000000000000000000000000000000007fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff60035416176003557f62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a2586020604051338152a1005b346101835760c07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602061061b612097565b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610183573373ffffffffffffffffffffffffffffffffffffffff600354160361109e577fffffffffffffffffffffffff000000000000000000000000000000000000000060035416600355600254337fffffffffffffffffffffffff000000000000000000000000000000000000000082161760025573ffffffffffffffffffffffffffffffffffffffff3391167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e05f80a3005b7f118cdaa7000000000000000000000000000000000000000000000000000000005f523360045260245ffd5b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101835761110061252c565b7fffffffffffffffffffffffff0000000000000000000000000000000000000000600354166003555f73ffffffffffffffffffffffffffffffffffffffff6002547fffffffffffffffffffffffff00000000000000000000000000000000000000008116600255167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e08280a3005b346101835760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610183576004355f526005602052606060405f2067ffffffffffffffff60018254920154604051928352818116602084015260401c166040820152f35b346101835760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101835773ffffffffffffffffffffffffffffffffffffffff611242611d03565b165f526006602052602067ffffffffffffffff60405f205416604051908152f35b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602060ff60035460a01c166040519015158152f35b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602067ffffffffffffffff60035460a81c16604051908152f35b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101835761132461252c565b60035460ff8160a01c1615611384577fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff166003557f5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa6020604051338152a1005b7f8dfc202b000000000000000000000000000000000000000000000000000000005f5260045ffd5b346101835760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610183576004355f526007602052602060ff60405f2054166040519015158152f35b34610183575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018357602060405167ffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b346101835760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610183576004356114956122fb565b80156104a257335f52600460205260405f20548082116115ab57816114b99161207d565b335f5260046020528060405f20557f000000000000000000000000000000000000000000000000000000000000000091604051927fa9059cbb000000000000000000000000000000000000000000000000000000005f52336004528160245260205f60448180855af160015f511481161561158c575b846040521561043f5750825260208201527f92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc660403392a260017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b60018115166115a257813b15153d15161661152f565b843d5f823e3d90fd5b7f19f75dbd000000000000000000000000000000000000000000000000000000005f5260045ffd5b34610183577ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360161010081126101835760c0136101835760c43567ffffffffffffffff811161018357366023820112156101835780600401359067ffffffffffffffff82116101835736602483830101116101835760e43567ffffffffffffffff811161018357611669903690600401611cd2565b92906116736122c4565b61167b6122fb565b6044359283156104a25761168d611d80565b73ffffffffffffffffffffffffffffffffffffffff806116ab611da3565b16911614611caa5767ffffffffffffffff60035460a81c169473ffffffffffffffffffffffffffffffffffffffff6116e1611d80565b165f52600660205267ffffffffffffffff60405f2054167f00000000000000000000000000000000000000000000000000000000000000009067ffffffffffffffff61172d8383611e07565b168810611c705750507f00000000000000000000000000000000000000000000000000000000000000009167ffffffffffffffff83168088119182611b6f575b610c0561178a6117909261177f612097565b996024369201611f39565b88612878565b73ffffffffffffffffffffffffffffffffffffffff806117ae611d80565b16911603611b4757855f52600760205260ff60405f205416611b1b57871015611b0c5767ffffffffffffffff875b1690818303611add5715611ad5576117f48388611e29565b90935b5f917fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa182360301925b8681106119cb57898989805f52600760205260405f2060017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0082541617905573ffffffffffffffffffffffffffffffffffffffff61187c611d80565b165f52600460205260405f205482811061197a578261189a9161207d565b73ffffffffffffffffffffffffffffffffffffffff6118b7611d80565b165f52600460205260405f205573ffffffffffffffffffffffffffffffffffffffff6118e1611da3565b165f52600460205260405f206118f883825461208a565b90557f44d622225b361df3678855db60c3f8769704e66ae527c461d647a4e00f542135604073ffffffffffffffffffffffffffffffffffffffff8061193b611d80565b96611944611da3565b908451978852602088015216951693a460017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b905073ffffffffffffffffffffffffffffffffffffffff611999611d80565b7f4f4d34e4000000000000000000000000000000000000000000000000000000005f521660045260245260445260645ffd5b6119df67ffffffffffffffff821683611e07565b67ffffffffffffffff6119f28883611e4b565b165f52600560205260405f205486831015610c70578260051b850135868112156101835785019060608236031261018357604051611a2f81611eaf565b82356003811015610183578152602083013567ffffffffffffffff811161018357611a5d9036908501612001565b6020820152604083013567ffffffffffffffff811161018357611a9193611a8691369101612001565b60408201528b612372565b15611a9f5750600101611820565b67ffffffffffffffff907fe9668f3b000000000000000000000000000000000000000000000000000000005f521660045260245ffd5b5f90936117f7565b507fc38e852a000000000000000000000000000000000000000000000000000000005f5260045260245260445ffd5b67ffffffffffffffff836117dc565b857fc8e03f03000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7f33ddf6c7000000000000000000000000000000000000000000000000000000005f5260045ffd5b67ffffffffffffffff611b8b86611b86818d611e29565b611e4b565b165f52600560205267ffffffffffffffff80600160405f20015460401c16611bb1611e98565b7f00000000000000000000000000000000000000000000000000000000000000009083821693849116115f14611c6857611bf290611bed611e98565b611e29565b915b67ffffffffffffffff611c05611e98565b1611801590611c54575b611c1a57505061176d565b67ffffffffffffffff92507f84bedf1e000000000000000000000000000000000000000000000000000000005f526004521660245260445ffd5b5067ffffffffffffffff8216811015611c0f565b505f91611bf4565b67ffffffffffffffff92507f5ed67765000000000000000000000000000000000000000000000000000000005f526004521660245260445ffd5b7fc930ea6c000000000000000000000000000000000000000000000000000000005f5260045ffd5b9181601f840112156101835782359167ffffffffffffffff8311610183576020808501948460051b01011161018357565b6004359073ffffffffffffffffffffffffffffffffffffffff8216820361018357565b907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f602080948051918291828752018686015e5f8582860101520116010190565b6004359067ffffffffffffffff8216820361018357565b60043573ffffffffffffffffffffffffffffffffffffffff811681036101835790565b60243573ffffffffffffffffffffffffffffffffffffffff811681036101835790565b3573ffffffffffffffffffffffffffffffffffffffff811681036101835790565b67ffffffffffffffff60019116019067ffffffffffffffff8211610acd57565b9067ffffffffffffffff8091169116019067ffffffffffffffff8211610acd57565b9067ffffffffffffffff8091169116039067ffffffffffffffff8211610acd57565b9067ffffffffffffffff16908115611e6b5767ffffffffffffffff160690565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601260045260245ffd5b60843567ffffffffffffffff811681036101835790565b6060810190811067ffffffffffffffff821117611ecb57604052565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff821117611ecb57604052565b92919267ffffffffffffffff8211611ecb5760405191611f81601f82017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01660200184611ef8565b829481845281830111610183578281602093845f960137010152565b67ffffffffffffffff8111611ecb5760051b60200190565b929190611fc181611f9d565b93611fcf6040519586611ef8565b602085838152019160051b810192831161018357905b828210611ff157505050565b8135815260209182019101611fe5565b919060808382031261018357604051906080820182811067ffffffffffffffff821117611ecb57604052819380358352602081013560208401526040810135604084015260608101359067ffffffffffffffff8211610183570181601f820112156101835760609181602061207893359101611fb5565b910152565b91908203918211610acd57565b91908201809211610acd57565b60043573ffffffffffffffffffffffffffffffffffffffff81169081810361018357506024359073ffffffffffffffffffffffffffffffffffffffff82169182810361018357506084359167ffffffffffffffff83168084036101835761216493506040519160208301937fc6d921a43b737bc40b09bebbbabb9d17e46f310287ce5fd65e69e215b63adb03855260408401526060830152604435608083015260643560a083015260c082015260a43560e082015260e0815261215c61010082611ef8565b51902061254d565b90565b9190811015610c705760051b0190565b9392959491604051908160208101938490925f905b8082106122885750506121c69250037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08101835282611ef8565b5190209160405160208101918297905f5b81811061227257505050612216816121649798037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08101835282611ef8565b5190206040519267ffffffffffffffff60208501957f639e109cbe7ad8181b71ddf08d4c7133cde70c8c3e351d05782fd5112ed1477087521660408501526060840152608083015260a082015260a0815261215c60c082611ef8565b82358a526020998a0199909201916001016121d7565b9190925083359073ffffffffffffffffffffffffffffffffffffffff82168092036101835760208160019382935201940192018492939161218c565b60ff60035460a01c166122d357565b7fd93c0665000000000000000000000000000000000000000000000000000000005f5260045ffd5b60027f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00541461234a5760027f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055565b7f3ee5aeb5000000000000000000000000000000000000000000000000000000005f5260045ffd5b907fc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470831461252457805160038110156124c157156124ee57805160038110156124c15760011461245957602081016123cb84825161298a565b9384612442575b508361242b575b83612407575b836123fb575b50826123f057505090565b604001515111919050565b5151821192505f6123e5565b92506020604082015101516020845101519060018201809211610acd5714926123df565b9250604083510151604080830151015114926123d9565b612452919450604083015161298a565b925f6123d2565b6020612468910192835161298a565b9182612481575b8261247957505090565b515110919050565b8092505160406020820151910151907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8201918211610acd57149161246f565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602160045260245ffd5b60206124fd910192835161298a565b9182612516575b8261250e57505090565b515111919050565b805160200151159250612504565b505050600190565b73ffffffffffffffffffffffffffffffffffffffff60025416330361109e57565b604290612558612af4565b90604051917f19010000000000000000000000000000000000000000000000000000000000008352600283015260228201522090565b8051821015610c705760209160051b010190565b80518015612852576125b381611f9d565b906125c16040519283611ef8565b8082526125cd81611f9d565b927fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06020840194013685375f5b82811061278d5750505b6001811161261757505115610c70575190565b60018101808211610acd5760011c905f5b8160011c81106126b45750600180821614612644575b50612604565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8101908111610acd57612678908361258e565b517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8201828111610acd576126ad908461258e565b525f61263e565b8060011b907f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff81168103610acd576126ec828661258e565b5160018301809311610acd5761274d61277961270a6001958961258e565b5160405192839160208301958690916041927f01000000000000000000000000000000000000000000000000000000000000008352600183015260218201520190565b037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08101835282611ef8565b519020612786828761258e565b5201612628565b8015158061280a575b6127df57806127a76001928461258e565b516040515f60208083019182528583010192909252602181526127cb604182611ef8565b5190206127d8828761258e565b52016125fa565b7f046ef18a000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b50612815818361258e565b517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8201828111610acd5761284a908461258e565b511015612796565b50507fc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a47090565b81519190604183036128a8576128a19250602082015190606060408401519301515f1a90612e60565b9192909190565b50505f9160029190565b60048110156124c157806128c4575050565b600181036128f4577ff645eedf000000000000000000000000000000000000000000000000000000005f5260045ffd5b6002810361292857507ffce698f7000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b6003146129325750565b7fd78bce0c000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8114610acd5760010190565b906020820191825190604081019182511115612aec5780516040515f602082019081526021808301939093529181526129c4604182611ef8565b51902093519151915f925b600181116129f057505060600151511491826129ea57505090565b14919050565b9092946001808516145f14612a915760608301519081518714612a865761274d612a64612a2089612a6d9561258e565b519260405192839160208301958690916041927f01000000000000000000000000000000000000000000000000000000000000008352600183015260218201520190565b5190209561295d565b925b60011c9060018101809111610acd5760011c6129cf565b505050505050505f90565b94927fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8201828111610acd578114612a6f57929460608301519081518714612a865761274d612a6461270a89612ae69561258e565b92612a6f565b505050505f90565b73ffffffffffffffffffffffffffffffffffffffff7f000000000000000000000000000000000000000000000000000000000000000016301480612bf4575b15612b5c577f000000000000000000000000000000000000000000000000000000000000000090565b60405160208101907f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f82527f000000000000000000000000000000000000000000000000000000000000000060408201527f000000000000000000000000000000000000000000000000000000000000000060608201524660808201523060a082015260a08152612bee60c082611ef8565b51902090565b507f00000000000000000000000000000000000000000000000000000000000000004614612b33565b60ff8114612c7c5760ff811690601f8211612c545760405191612c41604084611ef8565b6020808452838101919036833783525290565b7fb3512b0c000000000000000000000000000000000000000000000000000000005f5260045ffd5b506040515f80548060011c9160018216918215612d86575b602084108314612d59578385528492908115612d1c5750600114612cbf575b61216492500382611ef8565b505f80805290917f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e5635b818310612d0057505090602061216492820101612cb3565b6020919350806001915483858801015201910190918392612ce8565b602092506121649491507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001682840152151560051b820101612cb3565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b92607f1692612c94565b60ff8114612db45760ff811690601f8211612c545760405191612c41604084611ef8565b506040515f6001548060011c9160018216918215612e56575b602084108314612d59578385528492908115612d1c5750600114612df75761216492500382611ef8565b5060015f90815290917fb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf65b818310612e3a57505090602061216492820101612cb3565b6020919350806001915483858801015201910190918392612e22565b92607f1692612dcd565b91907f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08411612eef579160209360809260ff5f9560405194855216868401526040830152606082015282805260015afa15612ee4575f5173ffffffffffffffffffffffffffffffffffffffff811615612eda57905f905f90565b505f906001905f90565b6040513d5f823e3d90fd5b5050505f916003919056fea264697066735822122043c021a0451532743e6e2464a55d60a0c69e03a532dce718365e7184eabbd17464736f6c634300081a0033" as const;
