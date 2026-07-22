export const mockTokenAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allowance",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "spender",
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
    "name": "approve",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "balanceOf",
    "inputs": [
      {
        "name": "account",
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
    "name": "decimals",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "mint",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
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
    "name": "name",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "symbol",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalSupply",
    "inputs": [],
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
    "name": "transfer",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferFrom",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Approval",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "spender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Transfer",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "ERC20InsufficientAllowance",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InsufficientBalance",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidApprover",
    "inputs": [
      {
        "name": "approver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidReceiver",
    "inputs": [
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSender",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSpender",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      }
    ]
  }
] as const;

export const mockTokenBytecode = "0x60806040523461031357604080519081016001600160401b0381118282101761022657604090815260098252684d6f636b205553444360b81b602083015280519081016001600160401b038111828210176102265760405260048152635553444360e01b602082015281516001600160401b03811161022657600354600181811c91168015610309575b602082101461020857601f81116102a6575b50602092601f821160011461024557928192935f9261023a575b50508160011b915f199060031b1c1916176003555b80516001600160401b03811161022657600454600181811c9116801561021c575b602082101461020857601f81116101a5575b50602091601f8211600114610145579181925f9261013a575b50508160011b915f199060031b1c1916176004555b604051610a5d90816103188239f35b015190505f80610116565b601f1982169260045f52805f20915f5b85811061018d57508360019510610175575b505050811b0160045561012b565b01515f1960f88460031b161c191690555f8080610167565b91926020600181928685015181550194019201610155565b60045f527f8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b601f830160051c810191602084106101fe575b601f0160051c01905b8181106101f357506100fd565b5f81556001016101e6565b90915081906101dd565b634e487b7160e01b5f52602260045260245ffd5b90607f16906100eb565b634e487b7160e01b5f52604160045260245ffd5b015190505f806100b5565b601f1982169360035f52805f20915f5b86811061028e5750836001959610610276575b505050811b016003556100ca565b01515f1960f88460031b161c191690555f8080610268565b91926020600181928685015181550194019201610255565b60035f527fc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b601f830160051c810191602084106102ff575b601f0160051c01905b8181106102f4575061009b565b5f81556001016102e7565b90915081906102de565b90607f1690610089565b5f80fdfe6080806040526004361015610012575f80fd5b5f3560e01c90816306fdde031461077257508063095ea7b3146106c557806318160ddd1461068a57806323b872dd146104f6578063313ce567146104bd57806340c10f19146103be57806370a082311461035c57806395d89b4114610169578063a9059cbb1461011a5763dd62ed3e1461008a575f80fd5b346101165760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610116576100c16108eb565b73ffffffffffffffffffffffffffffffffffffffff6100de61090e565b91165f52600160205273ffffffffffffffffffffffffffffffffffffffff60405f2091165f52602052602060405f2054604051908152f35b5f80fd5b346101165760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101165761015e6101546108eb565b6024359033610931565b602060405160018152f35b34610116575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610116576040515f600454908160011c60018316928315610352575b6020821084146103255781855284939081156102c5575060011461024b575b5003601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01681019067ffffffffffffffff82118183101761021e5761021a829182604052826108a3565b0390f35b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b60045f90815291507f8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b5b8183106102a957505081016020017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06101ce565b6020919350806001915483858801015201910190918392610275565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001660208581019190915291151560051b840190910191507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe090506101ce565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b90607f16906101af565b346101165760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101165773ffffffffffffffffffffffffffffffffffffffff6103a86108eb565b165f525f602052602060405f2054604051908152f35b346101165760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610116576103f56108eb565b73ffffffffffffffffffffffffffffffffffffffff16602435811561049157600254908082018092116104645760207fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef915f9360025584845283825260408420818154019055604051908152a3005b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b7fec442f05000000000000000000000000000000000000000000000000000000005f525f60045260245ffd5b34610116575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261011657602060405160068152f35b346101165760607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126101165761052d6108eb565b61053561090e565b6044359073ffffffffffffffffffffffffffffffffffffffff831692835f52600160205260405f2073ffffffffffffffffffffffffffffffffffffffff33165f5260205260405f20547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff81106105b1575b5061015e9350610931565b83811061065657841561062a5733156105fe5761015e945f52600160205260405f2073ffffffffffffffffffffffffffffffffffffffff33165f526020528360405f2091039055846105a6565b7f94280d62000000000000000000000000000000000000000000000000000000005f525f60045260245ffd5b7fe602df05000000000000000000000000000000000000000000000000000000005f525f60045260245ffd5b83907ffb8f41b2000000000000000000000000000000000000000000000000000000005f523360045260245260445260645ffd5b34610116575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610116576020600254604051908152f35b346101165760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610116576106fc6108eb565b60243590331561062a5773ffffffffffffffffffffffffffffffffffffffff169081156105fe57335f52600160205260405f20825f526020528060405f20556040519081527f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b92560203392a3602060405160018152f35b34610116575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610116575f600354908160011c60018316928315610899575b6020821084146103255781855284939081156102c5575060011461081f575003601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01681019067ffffffffffffffff82118183101761021e5761021a829182604052826108a3565b60035f90815291507fc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b5b81831061087d57505081016020017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe06101ce565b6020919350806001915483858801015201910190918392610849565b90607f16906107b5565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f602060409481855280519182918282880152018686015e5f8582860101520116010190565b6004359073ffffffffffffffffffffffffffffffffffffffff8216820361011657565b6024359073ffffffffffffffffffffffffffffffffffffffff8216820361011657565b73ffffffffffffffffffffffffffffffffffffffff169081156109fb5773ffffffffffffffffffffffffffffffffffffffff1691821561049157815f525f60205260405f20548181106109c957817fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef92602092855f525f84520360405f2055845f525f825260405f20818154019055604051908152a3565b827fe450d38c000000000000000000000000000000000000000000000000000000005f5260045260245260445260645ffd5b7f96c6fd1e000000000000000000000000000000000000000000000000000000005f525f60045260245ffdfea264697066735822122090e478d2d7ce859b17701bc04904da1c4422bb425a42e4f7cbcef32e93e1bc8b64736f6c634300081a0033" as const;
