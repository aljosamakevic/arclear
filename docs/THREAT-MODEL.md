# Arclear threat model

## Trust model, stated plainly

- **Safety** (no balance moves without its owner's signed consent over the
  exact full position set) is enforced **on-chain**, unconditionally.
- **Liveness** (rounds actually happen) is bounded by v2's threshold
  consent (PROTOCOL.md "Threshold consent"): non-consenters are excluded in
  one deterministic batch and the round rebuilds from the consenting subset
  — at most two signature-collection passes per attempt. v1 traded liveness
  for simplicity; v2 caps the cost of a stall at rebuild latency.
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
| 7 | Grief by stalling or refusing to sign | threshold consent (v2): timeouts and reasoned refusals are excluded in one deterministic batch and the round rebuilds from the consenting subset — worst case two collection passes, a latency cost, never a safety cost. A reasoned refusal (`verifyProposal` fails locally) is the safety mechanism working and does **not** count as a missed window; only timeouts advance the miss counter. Bilateral credit caps still bound the refuser's paper | rebuild property tests (`test/rebuild.test.ts`); e2e liveness scenario (`npm run e2e:anvil`); griefing analysis in PROTOCOL.md |
| 8 | Withdraw collateral between consent and execution | round reverts **in full** — equivalent to refusing consent; never partial settlement | `test_revert_withdrawFrontRunsExecution` |
| 9 | Sneak a duplicate participant / unsorted set | strictly-ascending check (one O(n) pass) | `test_revert_duplicateParticipant`, `test_revert_unsortedParticipants` |
| 10 | Signature malleability | OpenZeppelin ECDSA rejects high-s values | fuzz perturbation test |
| 11 | Rounding games | impossible: integer add/sub in base units; no division exists in the protocol | — |
| 12 | Fee-on-transfer / weird ERC-20s | SafeERC20 everywhere; fee-on-transfer explicitly unsupported (documented) | — |
| 13 | Owner rug | owner can only pause deposits+rounds; **withdrawals are never pausable**, no upgradeability, no fee switch, no access to funds | `test_withdraw_worksWhilePaused`, `test_pause_onlyOwner` |

## Known limitations and their answers

| Limitation | Consequence | Status / answer |
|---|---|---|
| Unanimous consent over the candidate set | one stalled participant delays settlement (funds never at risk) | **shipped in v2**: threshold consent — non-consenters are **excluded and recomputed**, never outvoted; the final executed set still signs unanimously; worst case two collection passes (PROTOCOL.md "Threshold consent") |
| Plain-hash manifest | no efficient per-IOU inclusion/non-inclusion proofs | planned: sorted-leaf merkle root in the same `bytes32` field |
| No on-chain IOU redemption | a vanished counterparty's paper is only recoverable socially; loss bounded by credit caps | planned: redemption against defaulter collateral, gated by merkle non-inclusion proofs across recent rounds; reads the coordinator's consecutive-missed-window counter (timeouts only — a reasoned refusal never flags a member) |
| Coordinator is a single relay | availability (not integrity) depends on it | any participant can run one; gossip is a drop-in replacement |
| Sweep evidence (docs/sweep) | at small n the worst participant's tail-case saving is ~0% | threshold consent (shipped in v2) removes the liveness blocker for larger pools — see README findings |
