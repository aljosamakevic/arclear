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
- **Recovery** (v2): a creditor holding a signed IOU from a debtor absent
  from the last ≥ K executed rounds can redeem it directly against the
  debtor's posted collateral (`redeemIOU`, PROTOCOL.md "IOU redemption") —
  **best-effort by design**: it recovers posted, still-present collateral
  only and races the never-pausable `withdraw`. Credit caps remain the
  exposure bound; redemption is not insurance.
- The coordinator is a convenience relay with no keys and no authority — v2
  adds it none: the redemption gate reads on-chain executed-round staleness,
  never coordinator attestations.

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
| 13 | Owner rug | owner can only pause deposits+rounds+redemptions; **withdrawals are never pausable**, no upgradeability, no fee switch, no access to funds | `test_withdraw_worksWhilePaused`, `test_withdraw_worksWhilePaused_V2`, `test_pause_onlyOwner` |
| 14 | Merkle second-preimage (internal node replayed as a leaf, or cross-domain confusion) | RFC 6962-style `0x00`/`0x01` prefix domain separation on every leaf/node hash; EIP-712 digests (`\x19\x01`-prefixed) cannot collide with either domain | TS↔Solidity parity fixtures (`test/fixtures/merkle.json`) incl. negative vectors; `MerkleParity.t.sol` |
| 15 | Double-claim, net → redeem (redeem an IOU already netted, after its round's root leaves the ring) | L-bounded coverage rule: redemption requires full history buffered OR `executedAt(oldest) < expiry − L`, so every round that could have consumed the IOU is still buffered; non-inclusion proven against **every** buffered root; fail-closed when uncoverable | `test_revert_redeemIOU_nonInclusionInvalid` (contained id structurally unprovable), coverage revert tests both branches + positive post-eviction case |
| 16 | Double-claim, redeem → net (settle a redeemed IOU in a later round) | nullifier keyed by the IOU id; `executeRound` reverts `NullifiedIdInManifest` on any nullified consumed id; coordinator folds `IouRedeemed` logs into netting exclusions | `test_revert_executeRound_nullifiedId`, `testFuzz_redeemNullifierIdempotent` (512 runs, balances frozen), e2e permanent-exclusion tail |
| 17 | Forged position claims (lying `index`/`leafCount` to fake a bracketing non-inclusion) | verification schedule is determined by `(index, leafCount)` — a lie changes the sibling-consumption schedule, so matching the root needs a keccak second preimage; kind-specific position checks bind the bracket shapes | `testFuzz_redeemProofPerturbation_reverts`, `testFuzz_redeemProofSetSkip_reverts` (512 runs each), fast-check adversarial properties |
| 18 | Keep-alive censorship griefing (live debtor dust-cycles to keep `lastRound` fresh while censoring one creditor) | **documented limitation, accepted**: visible on-chain, costs the debtor gas every round, out of protocol scope to punish in the Net product; credit caps are the creditor's defense (PROTOCOL.md griefing analysis) | — |
| 19 | Debtor exit race (withdraw free collateral before redemption lands) | **unfixable by design** — `withdraw` is never pausable and must not be; redemption is best-effort recovery of posted, still-present collateral, documented plainly | withdraw-race honesty test (`redeemIOU` reverts `InsufficientCollateral` after exit) |
| 20 | Proof-set TOCTOU (round executes between proof generation and redemption mining; or prover omits the containing root) | contract derives the required proof set from its own `roundNonce`/`RING` — exactly one proof per buffered round, positionally matched; any mismatch reverts and the creditor regenerates from calldata | `testFuzz_redeemProofSetSkip_reverts`, `ProofCountMismatch` revert tests |

## Known limitations and their answers

| Limitation | Consequence | Status / answer |
|---|---|---|
| Unanimous consent over the candidate set | one stalled participant delays settlement (funds never at risk) | **shipped in v2**: threshold consent — non-consenters are **excluded and recomputed**, never outvoted; the final executed set still signs unanimously; worst case two collection passes (PROTOCOL.md "Threshold consent") |
| Plain-hash manifest | no efficient per-IOU inclusion/non-inclusion proofs | **shipped in v2**: sorted-leaf merkle root in the same `bytes32` field; `executeRound` derives it on-chain from `consumedIds` calldata, so every round's leaf set is publicly reconstructible and per-IOU proofs need no coordinator (PROTOCOL.md "Manifest commitment") |
| No on-chain IOU redemption | a vanished counterparty's paper was only recoverable socially; loss bounded by credit caps | **shipped in v2**: `redeemIOU` recovers against the debtor's posted collateral, gated by on-chain staleness — the debtor absent from the last ≥ K **executed rounds** (never coordinator attestations; the coordinator's miss counters are an off-chain early-warning signal only) — plus the L-bounded coverage rule and non-inclusion proofs against every buffered root. Best-effort: it races the never-pausable `withdraw`; credit caps remain the exposure bound (PROTOCOL.md "IOU redemption") |
| Coordinator is a single relay | availability (not integrity) depends on it | any participant can run one; gossip is a drop-in replacement |
| Sweep evidence (docs/sweep) | at small n the worst participant's tail-case saving is ~0% | threshold consent (shipped in v2) removes the liveness blocker for larger pools — see README findings |
