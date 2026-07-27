/** ABI + creation bytecode for ClearingHubV3, pasted from contracts/out after `forge build`. */
export const clearingHubV3Abi = [
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
      "name": "consumed",
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
          "name": "consumed_",
          "type": "tuple[]",
          "internalType": "struct ClearingHubV3.ConsumedRef[]",
          "components": [
            {
              "name": "id",
              "type": "bytes32",
              "internalType": "bytes32"
            },
            {
              "name": "partyAIdx",
              "type": "uint32",
              "internalType": "uint32"
            },
            {
              "name": "partyBIdx",
              "type": "uint32",
              "internalType": "uint32"
            }
          ]
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
          "internalType": "struct ClearingHubV3.Iou",
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
      "name": "isConsumed",
      "inputs": [
        {
          "name": "iou",
          "type": "tuple",
          "internalType": "struct ClearingHubV3.Iou",
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
          "type": "bool",
          "internalType": "bool"
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
      "name": "manifestLeafId",
      "inputs": [
        {
          "name": "id",
          "type": "bytes32",
          "internalType": "bytes32"
        },
        {
          "name": "partyA",
          "type": "address",
          "internalType": "address"
        },
        {
          "name": "partyB",
          "type": "address",
          "internalType": "address"
        }
      ],
      "outputs": [
        {
          "name": "",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ],
      "stateMutability": "pure"
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
          "internalType": "struct ClearingHubV3.Iou",
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
      "stateMutability": "pure"
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
      "name": "AlreadyConsumed",
      "inputs": [
        {
          "name": "leafId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ]
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
      "name": "EmptyRound",
      "inputs": []
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
      "name": "IouAlreadyNetted",
      "inputs": [
        {
          "name": "leafId",
          "type": "bytes32",
          "internalType": "bytes32"
        }
      ]
    },
    {
      "type": "error",
      "name": "LengthMismatch",
      "inputs": []
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
      "name": "PartyIndexOutOfRange",
      "inputs": [
        {
          "name": "refIndex",
          "type": "uint256",
          "internalType": "uint256"
        },
        {
          "name": "partyIdx",
          "type": "uint32",
          "internalType": "uint32"
        },
        {
          "name": "participantCount",
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
      "name": "RenounceDisabled",
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
      "name": "SelfConsumedRef",
      "inputs": [
        {
          "name": "refIndex",
          "type": "uint256",
          "internalType": "uint256"
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
      "name": "ZeroAddressParty",
      "inputs": []
    },
    {
      "type": "error",
      "name": "ZeroAmount",
      "inputs": []
    }
  ] as const;

export const clearingHubV3Bytecode = "0x6101a0806040523461024957604081612fe68038038091610020828561024d565b833981010312610249578051906001600160a01b038216820361024957602001516001600160401b038116918282036102495760405161006160408261024d565b600e815260208101906d20b931a1b632b0b934b733a43ab160911b82526040519161008d60408461024d565b600183526020830191603160f81b83526100a681610284565b610120526100b38461041a565b61014052519020918260e05251902080610100524660a0526040519060208201927f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8452604083015260608201524660808201523060a082015260a0815261011c60c08261024d565b5190206080523060c052331561023657600380546001600160a01b0319908116909155600280549182163390811790915560405194916001600160a01b03167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e05f80a360017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f005515610227576101605261018052612a9390816105538239608051816126a3015260a0518161275a015260c05181612674015260e051816126f20152610100518161271801526101205181610bc601526101405181610bef01526101605181818161016b015281816102ec0152611b400152610180518181816104a601526107c70152f35b6301f30c8760e21b5f5260045ffd5b631e4fbdf760e01b5f525f60045260245ffd5b5f80fd5b601f909101601f19168101906001600160401b0382119082101761027057604052565b634e487b7160e01b5f52604160045260245ffd5b908151602081105f146102fe575090601f8151116102be5760208151910151602082106102af571790565b5f198260200360031b1b161790565b604460209160405192839163305a27a960e01b83528160048401528051918291826024860152018484015e5f828201840152601f01601f19168101030190fd5b6001600160401b038111610270575f54600181811c91168015610410575b60208210146103fc57601f81116103ca575b50602092601f821160011461036b57928192935f92610360575b50508160011b915f199060031b1c1916175f5560ff90565b015190505f80610348565b601f198216935f8052805f20915f5b8681106103b2575083600195961061039a575b505050811b015f5560ff90565b01515f1960f88460031b161c191690555f808061038d565b9192602060018192868501518155019401920161037a565b5f8052601f60205f20910160051c810190601f830160051c015b8181106103f1575061032e565b5f81556001016103e4565b634e487b7160e01b5f52602260045260245ffd5b90607f169061031c565b908151602081105f14610445575090601f8151116102be5760208151910151602082106102af571790565b6001600160401b03811161027057600154600181811c91168015610548575b60208210146103fc57601f8111610515575b50602092601f82116001146104b457928192935f926104a9575b50508160011b915f199060031b1c19161760015560ff90565b015190505f80610490565b601f1982169360015f52805f20915f5b8681106104fd57508360019596106104e5575b505050811b0160015560ff90565b01515f1960f88460031b161c191690555f80806104d7565b919260206001819286850151815501940192016104c4565b60015f52601f60205f20910160051c810190601f830160051c015b81811061053d5750610476565b5f8155600101610530565b90607f169061046456fe60a06040526004361015610011575f80fd5b5f3560e01c80632e1a7d4d14611ad25780633d8b9e0714611a855780633f4ba83a146119c7578063415a1b861461197f5780634648c9431461193257806356896193146118cd5780635c975abb1461188a57806361f6b4451461181d578063715018a6146117c757806375d4a9b514610eac57806379ba509714610da457806382de6d1714610d6b5780638456cb5914610cc257806384b0196e14610b90578063884e582f146106915780638d6da444146106125780638da5cb5b146105c1578063a023226b1461052d578063a5fdc5de146104ca578063a932492f14610468578063b6b55f25146102a2578063e30c397814610251578063f2fde38b146101935763fc0c546a14610121575f80fd5b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57602060405173ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b5f80fd5b3461018f5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f5773ffffffffffffffffffffffffffffffffffffffff6101df611c4a565b6101e761224f565b16807fffffffffffffffffffffffff0000000000000000000000000000000000000000600354161760035573ffffffffffffffffffffffffffffffffffffffff600254167f38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e227005f80a3005b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57602073ffffffffffffffffffffffffffffffffffffffff60035416604051908152f35b3461018f5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f576004356102dc612270565b6102e46121d8565b8015610440577f00000000000000000000000000000000000000000000000000000000000000006040517f23b872dd000000000000000000000000000000000000000000000000000000005f5233600452306024528260445260205f60648180865af19060015f511482161561041f575b6040525f606052156103dd5750335f5260046020526103788160405f2054611eda565b335f5260046020528060405f205560405191825260208201527f73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca60403392a260017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b73ffffffffffffffffffffffffffffffffffffffff907f5274afe7000000000000000000000000000000000000000000000000000000005f521660045260245ffd5b90600181151661043757823b15153d15161690610355565b503d5f823e3d90fd5b7f1f2a2005000000000000000000000000000000000000000000000000000000005f5260045ffd5b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57602060405167ffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000168152f35b3461018f5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f5773ffffffffffffffffffffffffffffffffffffffff610516611c4a565b165f526004602052602060405f2054604051908152f35b3461018f5760807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57610564611c6d565b60243567ffffffffffffffff811161018f57610584903690600401611c84565b90916044359167ffffffffffffffff831161018f576020936105ad6105b9943690600401611c84565b9290916064359461208b565b604051908152f35b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57602073ffffffffffffffffffffffffffffffffffffffff60025416604051908152f35b3461018f5760607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f5760243573ffffffffffffffffffffffffffffffffffffffff8116810361018f576044359073ffffffffffffffffffffffffffffffffffffffff8216820361018f576020916105b991600435611fd6565b3461018f577ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360160e0811261018f5760c01361018f5760c43567ffffffffffffffff811161018f573660238201121561018f57806004013567ffffffffffffffff811161018f57366024828401011161018f5761070d612270565b6107156121d8565b60443590811561044057610727611d05565b73ffffffffffffffffffffffffffffffffffffffff80610745611d28565b16911614610b685773ffffffffffffffffffffffffffffffffffffffff61076a611d05565b16158015610b43575b610b1b5767ffffffffffffffff60035460a81c169273ffffffffffffffffffffffffffffffffffffffff6107a5611d05565b165f52600660205267ffffffffffffffff60405f20541667ffffffffffffffff7f0000000000000000000000000000000000000000000000000000000000000000169081810167ffffffffffffffff8111610aee5767ffffffffffffffff168610610ac057505061082f6108296108389261081e611f07565b946024369201611e76565b8361254b565b90929192612585565b73ffffffffffffffffffffffffffffffffffffffff80610856611d05565b16911603610a9857805f52600760205260ff60405f205416610a6d5761088c61087d611d05565b610885611d28565b9083611fd6565b805f52600560205260ff60405f205416610a425750805f52600760205260405f2060017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0082541617905573ffffffffffffffffffffffffffffffffffffffff6108f3611d05565b165f52600460205260405f20548281106109f1578261091191611cf8565b73ffffffffffffffffffffffffffffffffffffffff61092e611d05565b165f52600460205260405f205573ffffffffffffffffffffffffffffffffffffffff610958611d28565b165f52600460205260405f2061096f838254611eda565b90557f44d622225b361df3678855db60c3f8769704e66ae527c461d647a4e00f542135604073ffffffffffffffffffffffffffffffffffffffff806109b2611d05565b966109bb611d28565b908451978852602088015216951693a460017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b905073ffffffffffffffffffffffffffffffffffffffff610a10611d05565b7f4f4d34e4000000000000000000000000000000000000000000000000000000005f521660045260245260445260645ffd5b7fd3c63fa4000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7fc8e03f03000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7f33ddf6c7000000000000000000000000000000000000000000000000000000005f5260045ffd5b7f5ed67765000000000000000000000000000000000000000000000000000000005f5260045260245260445ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b7fc3aaeaa4000000000000000000000000000000000000000000000000000000005f5260045ffd5b5073ffffffffffffffffffffffffffffffffffffffff610b61611d28565b1615610773565b7fc930ea6c000000000000000000000000000000000000000000000000000000005f5260045ffd5b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57610c66610bea7f0000000000000000000000000000000000000000000000000000000000000000612780565b610c137f00000000000000000000000000000000000000000000000000000000000000006128f3565b6020610c7460405192610c268385611d7c565b5f84525f3681376040519586957f0f00000000000000000000000000000000000000000000000000000000000000875260e08588015260e0870190611cb5565b908582036040870152611cb5565b4660608501523060808501525f60a085015283810360c08501528180845192838152019301915f5b828110610cab57505050500390f35b835185528695509381019392810192600101610c9c565b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57610cf861224f565b610d00612270565b740100000000000000000000000000000000000000007fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff60035416176003557f62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a2586020604051338152a1005b3461018f5760c07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f5760206105b9611f07565b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f576003543373ffffffffffffffffffffffffffffffffffffffff821603610e80577fffffffffffffffffffffffff000000000000000000000000000000000000000016600355600254337fffffffffffffffffffffffff000000000000000000000000000000000000000082161760025573ffffffffffffffffffffffffffffffffffffffff3391167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e05f80a3005b7f118cdaa7000000000000000000000000000000000000000000000000000000005f523360045260245ffd5b3461018f5760a07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57610ee3611c6d565b60243567ffffffffffffffff811161018f57610f03903690600401611c84565b909160443567ffffffffffffffff811161018f57610f25903690600401611c84565b92909160643567ffffffffffffffff811161018f573660238201121561018f5767ffffffffffffffff81600401351161018f5736602460608360040135028301011161018f5760843567ffffffffffffffff811161018f57610f8b903690600401611c84565b95610f94612270565b610f9c6121d8565b67ffffffffffffffff60035460a81c169067ffffffffffffffff85169180830361179757506002861061176f57858114801590611765575b61173d578360040135156116e3575b610ff08460040135611e02565b94610ffa87611dea565b97611008604051998a611d7c565b8789527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe061103589611dea565b013660208b01375f5b866004013581101561123357606081028701604481018a63ffffffff61106383611e51565b1610156112235760648201918b63ffffffff61107e85611e51565b1610156111e05761108e82611e51565b63ffffffff8061109d86611e51565b169116146111b45760240135805f52600760205260ff60405f20541661118957611107908f6111016110e68f926110eb6110e663ffffffff6110de8a611e51565b168684611d6c565b611d4b565b9363ffffffff6110fa8a611e51565b1691611d6c565b91611fd6565b805f52600560205260ff60405f20541661115e5763ffffffff61115085948f6111438f918561114960019b99611157996111438e9c8d98611e62565b52611e51565b1690611e62565b168d611e62565b520161103e565b7f0f50872f000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7f47833236000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b837fb1aaae79000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b8b63ffffffff856111f086611e51565b907f8d6e145e000000000000000000000000000000000000000000000000000000005f526004521660245260445260645ffd5b63ffffffff836111f08d93611e51565b50908a88928a888a8e611245826122a7565b9a6112548c8b888c8b8d61208b565b6080525f915f80927fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe181360301905b8c8b81871061158e57505050505050508061156357505f5b8260040135811061151c575050505f955f5b86811061136d5750505050506112c290611ee7565b7fffffff0000000000000000ffffffffffffffffffffffffffffffffffffffffff7cffffffffffffffff0000000000000000000000000000000000000000006003549260a81b16911617600355604051938452602084015260408301527fd75dc2ed4b3b26b1d6e102d58791c1335f8c671dac68f205d0ef6f1408bda10e606060805193a360017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b61137b6110e6828988611d6c565b73ffffffffffffffffffffffffffffffffffffffff61139b838588611d6c565b35911690815f52600460205260405f20548b5f83125f146114d957507f80000000000000000000000000000000000000000000000000000000000000008214610aee57815f03908181106114a7576040600195949361141c8f947febdef941328d19c0bb28043197c4705da993b9b302943a4120acfa8bf0960fe594611cf8565b855f52600460205280835f2055611433878b611e62565b511580159061149e575b611453575b82519182526020820152a3016112ad565b61145c8d611ee7565b865f52600660205267ffffffffffffffff845f2091167fffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000825416179055611442565b5081151561143d565b837f4f4d34e4000000000000000000000000000000000000000000000000000000005f5260045260245260445260645ffd5b909a6040836115178161151160019998977febdef941328d19c0bb28043197c4705da993b9b302943a4120acfa8bf0960fe596611eda565b9f611eda565b61141c565b8061152960019284611e62565b515f52600560205260405f20827fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff008254161790550161129b565b7faad3b2d3000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b866115a3926110e69299949596979899611d6c565b73ffffffffffffffffffffffffffffffffffffffff80821695168511156116bb57938587101561168e578660051b8301358481121561018f57830180359067ffffffffffffffff821161018f5760200190803603821361018f5761082f61162473ffffffffffffffffffffffffffffffffffffffff9361162c933691611e76565b60805161254b565b16036116625761163d868f8c611d6c565b35905f8282019283129112908015821691151617610aee579460010193929190611283565b857fa1c97319000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52603260045260245ffd5b7f181a5518000000000000000000000000000000000000000000000000000000005f5260045ffd5b5f805b87811061171b575b50610fe3577fc493daac000000000000000000000000000000000000000000000000000000005f5260045ffd5b61172681848b611d6c565b35611733576001016116e6565b505060018a6116ee565b7fff633a38000000000000000000000000000000000000000000000000000000005f5260045ffd5b5085881415610fd4565b7f7c8babaa000000000000000000000000000000000000000000000000000000005f5260045ffd5b90507fc69cde43000000000000000000000000000000000000000000000000000000005f5260045260245260445ffd5b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f577f89051165000000000000000000000000000000000000000000000000000000005f5260045ffd5b3461018f5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f5773ffffffffffffffffffffffffffffffffffffffff611869611c4a565b165f526006602052602067ffffffffffffffff60405f205416604051908152f35b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57602060ff60035460a01c166040519015158152f35b3461018f5760c07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57611917611907611f07565b61190f611d05565b611101611d28565b5f526005602052602060ff60405f2054166040519015158152f35b3461018f5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f576004355f526005602052602060ff60405f2054166040519015158152f35b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57602067ffffffffffffffff60035460a81c16604051908152f35b3461018f575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f576119fd61224f565b60035460ff8160a01c1615611a5d577fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff166003557f5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa6020604051338152a1005b7f8dfc202b000000000000000000000000000000000000000000000000000000005f5260045ffd5b3461018f5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f576004355f526007602052602060ff60405f2054166040519015158152f35b3461018f5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261018f57600435611b0c6121d8565b801561044057335f52600460205260405f2054808211611c225781611b3091611cf8565b335f5260046020528060405f20557f000000000000000000000000000000000000000000000000000000000000000091604051927fa9059cbb000000000000000000000000000000000000000000000000000000005f52336004528160245260205f60448180855af160015f5114811615611c03575b84604052156103dd5750825260208201527f92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc660403392a260017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055005b6001811516611c1957813b15153d151616611ba6565b843d5f823e3d90fd5b7f19f75dbd000000000000000000000000000000000000000000000000000000005f5260045ffd5b6004359073ffffffffffffffffffffffffffffffffffffffff8216820361018f57565b6004359067ffffffffffffffff8216820361018f57565b9181601f8401121561018f5782359167ffffffffffffffff831161018f576020808501948460051b01011161018f57565b907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f602080948051918291828752018686015e5f8582860101520116010190565b91908203918211610aee57565b60043573ffffffffffffffffffffffffffffffffffffffff8116810361018f5790565b60243573ffffffffffffffffffffffffffffffffffffffff8116810361018f5790565b3573ffffffffffffffffffffffffffffffffffffffff8116810361018f5790565b919081101561168e5760051b0190565b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff821117611dbd57604052565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b67ffffffffffffffff8111611dbd5760051b60200190565b90611e0c82611dea565b611e196040519182611d7c565b8281527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0611e478294611dea565b0190602036910137565b3563ffffffff8116810361018f5790565b805182101561168e5760209160051b010190565b92919267ffffffffffffffff8211611dbd5760405191611ebe601f82017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01660200184611d7c565b82948184528183011161018f578281602093845f960137010152565b91908201809211610aee57565b67ffffffffffffffff60019116019067ffffffffffffffff8211610aee57565b60043573ffffffffffffffffffffffffffffffffffffffff81169081810361018f57506024359073ffffffffffffffffffffffffffffffffffffffff82169182810361018f57506084359167ffffffffffffffff831680930361018f57611fd3926040519160208301937fc6d921a43b737bc40b09bebbbabb9d17e46f310287ce5fd65e69e215b63adb03855260408401526060830152604435608083015260643560a083015260c082015260a43560e082015260e08152611fcb61010082611d7c565b51902061250a565b90565b919073ffffffffffffffffffffffffffffffffffffffff821673ffffffffffffffffffffffffffffffffffffffff8216105f14612064577fffffffffffffffffffffffffffffffffffffffff00000000000000000000000090915b81604051936020850195865260601b16604084015260601b1660548201526048815261205e606882611d7c565b51902090565b7fffffffffffffffffffffffffffffffffffffffff00000000000000000000000090612031565b9392959491604051908160208101938490925f905b80821061219c5750506120da9250037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08101835282611d7c565b5190209160405160208101918297905f5b8181106121865750505061212a81611fd39798037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08101835282611d7c565b5190206040519267ffffffffffffffff60208501957f639e109cbe7ad8181b71ddf08d4c7133cde70c8c3e351d05782fd5112ed1477087521660408501526060840152608083015260a082015260a08152611fcb60c082611d7c565b82358a526020998a0199909201916001016120eb565b9190925083359073ffffffffffffffffffffffffffffffffffffffff821680920361018f576020816001938293520194019201849293916120a0565b60027f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0054146122275760027f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f0055565b7f3ee5aeb5000000000000000000000000000000000000000000000000000000005f5260045ffd5b73ffffffffffffffffffffffffffffffffffffffff600254163303610e8057565b60ff60035460a01c1661227f57565b7fd93c0665000000000000000000000000000000000000000000000000000000005f5260045ffd5b805180156124e4576122b881611e02565b915f5b8281106124235750505b600181116122dc575080511561168e576020015190565b60018101808211610aee5760011c905f5b8160011c81106123795750600180821614612309575b506122c5565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8101908111610aee5761233d9083611e62565b517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8201828111610aee576123729084611e62565b525f612303565b8060011b907f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff81168103610aee576123b18286611e62565b5160018301809311610aee576123c960019387611e62565b516040519060208201927f01000000000000000000000000000000000000000000000000000000000000008452602183015260418201526041815261240f606182611d7c565b51902061241c8287611e62565b52016122ed565b8015158061249c575b612471578061243d60019284611e62565b5160405160208101915f835260218201526021815261245d604182611d7c565b51902061246a8287611e62565b52016122bb565b7f046ef18a000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b506124a78183611e62565b517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8201828111610aee576124dc9084611e62565b51101561242c565b50507fc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a47090565b60429061251561265d565b90604051917f19010000000000000000000000000000000000000000000000000000000000008352600283015260228201522090565b815191906041830361257b576125749250602082015190606060408401519301515f1a906129c3565b9192909190565b50505f9160029190565b60048110156126305780612597575050565b600181036125c7577ff645eedf000000000000000000000000000000000000000000000000000000005f5260045ffd5b600281036125fb57507ffce698f7000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b6003146126055750565b7fd78bce0c000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602160045260245ffd5b73ffffffffffffffffffffffffffffffffffffffff7f000000000000000000000000000000000000000000000000000000000000000016301480612757575b156126c5577f000000000000000000000000000000000000000000000000000000000000000090565b60405160208101907f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f82527f000000000000000000000000000000000000000000000000000000000000000060408201527f000000000000000000000000000000000000000000000000000000000000000060608201524660808201523060a082015260a0815261205e60c082611d7c565b507f0000000000000000000000000000000000000000000000000000000000000000461461269c565b60ff81146127df5760ff811690601f82116127b757604051916127a4604084611d7c565b6020808452838101919036833783525290565b7fb3512b0c000000000000000000000000000000000000000000000000000000005f5260045ffd5b506040515f80548060011c91600182169182156128e9575b6020841083146128bc57838552849290811561287f5750600114612822575b611fd392500382611d7c565b505f80805290917f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e5635b818310612863575050906020611fd392820101612816565b602091935080600191548385880101520191019091839261284b565b60209250611fd39491507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001682840152151560051b820101612816565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b92607f16926127f7565b60ff81146129175760ff811690601f82116127b757604051916127a4604084611d7c565b506040515f6001548060011c91600182169182156129b9575b6020841083146128bc57838552849290811561287f575060011461295a57611fd392500382611d7c565b5060015f90815290917fb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf65b81831061299d575050906020611fd392820101612816565b6020919350806001915483858801015201910190918392612985565b92607f1692612930565b91907f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08411612a52579160209360809260ff5f9560405194855216868401526040830152606082015282805260015afa15612a47575f5173ffffffffffffffffffffffffffffffffffffffff811615612a3d57905f905f90565b505f906001905f90565b6040513d5f823e3d90fd5b5050505f916003919056fea26469706673582212204e15322bcd515ab27207014df6e7c40c78ee90834fe7c6c32dcc712b885ac62264736f6c634300081a0033" as const;
