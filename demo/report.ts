import { formatUnits } from "viem";
import type { ExecutedRound } from "./coordinator.js";

export function fmt(baseUnits: bigint | string): string {
  return `$${formatUnits(BigInt(baseUnits), 6)}`;
}

export function printReport(round: ExecutedRound, explorerTx: (h: string) => string) {
  const gross = BigInt(round.grossVolume);
  const settled = BigInt(round.settledVolume);
  const compression =
    gross === 0n ? "100.0" : ((Number(gross - settled) / Number(gross)) * 100).toFixed(1);

  console.log("");
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│                 ARCLEAR NETTING ROUND                   │");
  console.log("└─────────────────────────────────────────────────────────┘");
  console.log(`  obligations netted     ${round.iouCount} IOUs`);
  console.log(`  gross value            ${fmt(gross)}`);
  console.log(`  settled on-chain       ${fmt(settled)}`);
  console.log(`  capital compression    ${compression}%`);
  console.log(`  participants           ${round.participants}`);
  console.log(`  transactions           ${round.iouCount} payments → 1 settlement tx`);
  console.log(`  round nonce            ${round.roundNonce}`);
  console.log(`  manifest               ${round.manifestHash}`);
  console.log(`  tx                     ${explorerTx(round.txHash)}`);
  console.log("");
}
