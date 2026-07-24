import {
  hashTypedData,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { Account } from "viem/accounts";
import { pvpDomain, PVP_TYPES } from "./domain.js";
import type { PvPProposal } from "./types.js";

function pvpMessage(p: {
  usdcLegDigest: Hex;
  eurcLegDigest: Hex;
  fxNumerator: bigint;
  fxDenominator: bigint;
}) {
  return {
    usdcLegDigest: p.usdcLegDigest,
    eurcLegDigest: p.eurcLegDigest,
    fxNumerator: p.fxNumerator,
    fxDenominator: p.fxDenominator,
  };
}

function proposalFields(proposal: PvPProposal) {
  return {
    usdcLegDigest: proposal.usdcLeg.digest,
    eurcLegDigest: proposal.eurcLeg.digest,
    fxNumerator: proposal.fxNumerator,
    fxDenominator: proposal.fxDenominator,
  };
}

/**
 * The EIP-712 PvPRound digest every union member signs — binds both leg
 * digests and the agreed rate. Typehash (byte-matches PvPRouter.sol):
 * PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)
 */
export function pvpDigest(
  router: Address,
  p: { usdcLegDigest: Hex; eurcLegDigest: Hex; fxNumerator: bigint; fxDenominator: bigint },
  chainId?: number,
): Hex {
  return hashTypedData({
    domain: pvpDomain(router, chainId),
    types: PVP_TYPES,
    primaryType: "PvPRound",
    message: pvpMessage(p),
  });
}

/** Union member signs consent over the shared PvPRound digest. */
export async function signPvPConsent(
  router: Address,
  proposal: PvPProposal,
  account: Account,
  chainId?: number,
): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({
    domain: pvpDomain(router, chainId),
    types: PVP_TYPES,
    primaryType: "PvPRound",
    message: pvpMessage(proposalFields(proposal)),
  });
}

/** Verify a union member's PvPRound consent signature. */
export async function verifyPvPConsent(
  router: Address,
  proposal: PvPProposal,
  participant: Address,
  signature: Hex,
  chainId?: number,
): Promise<boolean> {
  return verifyTypedData({
    address: participant,
    domain: pvpDomain(router, chainId),
    types: PVP_TYPES,
    primaryType: "PvPRound",
    message: pvpMessage(proposalFields(proposal)),
    signature,
  });
}
