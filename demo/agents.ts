import { mnemonicToAccount, type HDAccount } from "viem/accounts";

/** Anvil's default mnemonic — used automatically for local runs. */
export const ANVIL_MNEMONIC =
  "test test test test test test test test test test test junk";

export interface AgentPersona {
  name: string;
  emoji: string;
  role: string;
  account: HDAccount;
  /** Failure injection (D-13): when true the persona never answers a consent
   * request — distinguishable from refusal-for-cause (verifyProposal ok:false). */
  stalled: boolean;
}

/**
 * Five agent personas modeling a small service economy with mostly circular
 * flows — the shape netting compresses best. Index 0 of the mnemonic is
 * reserved for the deployer/relayer; agents use indices 1..5.
 */
export function agents(mnemonic: string): AgentPersona[] {
  const mk = (i: number) => mnemonicToAccount(mnemonic, { addressIndex: i });
  return [
    { name: "Crawler", emoji: "🕷️", role: "sells raw web data", account: mk(1), stalled: false },
    { name: "Summarizer", emoji: "📝", role: "sells summaries, buys data", account: mk(2), stalled: false },
    { name: "Oracle", emoji: "🔮", role: "sells signals, buys summaries", account: mk(3), stalled: false },
    { name: "Trader", emoji: "📈", role: "buys signals, sells fills", account: mk(4), stalled: false },
    { name: "Auditor", emoji: "🧾", role: "buys fills, sells reports to Crawler", account: mk(5), stalled: false },
  ];
}

export function relayer(mnemonic: string): HDAccount {
  return mnemonicToAccount(mnemonic, { addressIndex: 0 });
}
