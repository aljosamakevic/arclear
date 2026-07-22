/**
 * Generates test/fixtures/digest.json — the shared vector that locks EIP-712
 * encoding parity between the SDK (viem) and ClearingHub.sol (forge test
 * DigestParity.t.sol reads this same file). Deterministic by construction.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { iouId } from "../src/iou.js";
import { manifestHash, roundDigest, signConsent, buildProposal } from "../src/round.js";
import type { Iou } from "../src/types.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;

const keys = [
  "0x0000000000000000000000000000000000000000000000000000000000000a01",
  "0x0000000000000000000000000000000000000000000000000000000000000a02",
  "0x0000000000000000000000000000000000000000000000000000000000000a03",
] as const;

const accounts = keys
  .map((k) => privateKeyToAccount(k as Hex))
  .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

const participants = accounts.map((a) => a.address);
const deltas = [-3_000_000n, 1_000_000n, 2_000_000n];

const iou: Iou = {
  debtor: participants[0],
  creditor: participants[1],
  amount: 3_000_000n,
  nonce: 1n,
  expiry: 4_102_444_800n, // 2100-01-01
  ref: "0x" + "ab".repeat(32) as Hex,
};
const id = iouId(HUB, iou);
const ids = [id].sort() as Hex[];
const mh = manifestHash(ids);

const round = { roundNonce: 0n, participants, deltas, manifestHash: mh };
const digest = roundDigest(HUB, round);

const proposal = buildProposal(HUB, 0n, {
  participants,
  deltas,
  consumedIds: ids,
  settledVolume: 3_000_000n,
  grossVolume: 3_000_000n,
});

const consent = await signConsent(HUB, proposal, accounts[0]);

const fixture = {
  hub: HUB,
  chainId: 5042002,
  roundNonce: 0,
  participants,
  deltas: deltas.map(String),
  manifestHash: mh,
  digest,
  iouId: id,
  signer0: participants[0],
  consent0: consent,
};

const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "digest.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}`);
console.log(`digest ${digest}`);
