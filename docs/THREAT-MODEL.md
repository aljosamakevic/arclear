# Arclear v1 threat model

## Trust model, stated plainly

- **Safety** (no balance moves without its owner's signed consent over the
  exact full position set) is enforced **on-chain**, unconditionally.
- **Liveness** (rounds actually happen) depends on all affected participants
  cooperating. v1 deliberately trades liveness for simplicity.
- **Counterparty credit** between rounds is bounded **off-chain** by bilateral
  credit caps (`src/creditCap.ts`): a creditor stops serving a debtor whose
  unsettled paper exceeds the cap. Worst-case loss per counterparty = the cap.
- The coordinator is a convenience relay with no keys and no authority.

## Attack surface checklist

| # | Attack | Defense | Test |
|---|--------|---------|------|
| 1 | Replay an executed round | on-chain `roundNonce` check + increment | `test_revert_replaySameRound` |
| 2 | Replay a signature across hubs / tokens / chains | EIP-712 domain binds `verifyingContract` (per-token hub) and `chainId` | `test_revert_crossHubReplay` |
| 3 | Count one IOU twice in a netting | dedup by `iouId`; per-pair monotonic nonces make duplicates identical | vitest property: multiset == set |
| 4 | Re-net an IOU already settled in a prior round | coordinator excludes ids in executed manifests; `manifestHash` makes violations provable after the fact | coordinator `settledIds` + e2e |
| 5 | Malicious coordinator proposes wrong positions | dies by construction: every participant signs the same full-set digest and `verifyProposal` recomputes locally — never trusts | `test_revert_tamperedDelta`, `test_revert_tamperedManifest` |
| 6 | Forge or substitute a consent | ECDSA recovery must equal the participant at the same index | `test_revert_missingConsent`, fuzz perturbation |
| 7 | Grief by refusing to sign | liveness failure only — round aborts, nothing settles; rebuild without the refuser's IOUs, halt their bilateral credit | documented; abort path tested |
| 8 | Withdraw collateral between consent and execution | round reverts **in full** — equivalent to refusing consent; never partial settlement | `test_revert_withdrawFrontRunsExecution` |
| 9 | Sneak a duplicate participant / unsorted set | strictly-ascending check (one O(n) pass) | `test_revert_duplicateParticipant`, `test_revert_unsortedParticipants` |
| 10 | Signature malleability | OpenZeppelin ECDSA rejects high-s values | fuzz perturbation test |
| 11 | Rounding games | impossible: integer add/sub in base units; no division exists in the protocol | — |
| 12 | Fee-on-transfer / weird ERC-20s | SafeERC20 everywhere; fee-on-transfer explicitly unsupported (documented) | — |
| 13 | Owner rug | owner can only pause deposits+rounds; **withdrawals are never pausable**, no upgradeability, no fee switch, no access to funds | `test_withdraw_worksWhilePaused`, `test_pause_onlyOwner` |

## Known limitations (v1) and their v2 answers

| Limitation | Consequence | v2 answer |
|---|---|---|
| Unanimous consent | one stalled participant delays settlement (funds never at risk) | threshold consent: non-signers are **excluded and recomputed**, not outvoted — the final set still signs unanimously |
| Plain-hash manifest | no efficient per-IOU inclusion/non-inclusion proofs | sorted-leaf merkle root in the same `bytes32` field |
| No on-chain IOU redemption | a vanished counterparty's paper is only recoverable socially; loss bounded by credit caps | redemption against defaulter collateral, gated by merkle non-inclusion proofs across recent rounds |
| Coordinator is a single relay | availability (not integrity) depends on it | any participant can run one; gossip is a drop-in replacement |
| Sweep evidence (docs/sweep) | at small n the worst participant's tail-case saving is ~0% | larger pools need threshold consent first — see README findings |
