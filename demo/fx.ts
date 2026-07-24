/**
 * FX quote mirror for the PvP demo.
 *
 * The shape mirrors the official `arc-stablecoin-fx` sample's App Kit
 * `estimateSwap` quote: the rate is expressed as an AMOUNT PAIR
 * (`amountIn` USDC base units → `amountOut` EURC base units), never as a
 * decimal. Mirroring the shape is the D-06-sanctioned fallback — the sample
 * itself is a Next.js/Supabase app driven by the authenticated Circle App Kit
 * Swap SDK and is unreachable from a viem-only dependency-free SDK. A
 * production coordinator would source the pair from an App Kit `estimateSwap`
 * quote; the demo agrees on a deterministic sample pair instead. The rate is
 * *agreed*, not oracle-derived — unanimous consent bounds manipulation.
 */
export interface FxQuote {
  /** USDC base units in (6 decimals) — the rate denominator side. */
  amountIn: bigint;
  /** EURC base units out (6 decimals) — the rate numerator side. */
  amountOut: bigint;
  /** Unix seconds the quote was produced (per-round freshness metadata). */
  timestamp: number;
}

/**
 * Amount pair → the PvPRound's num/den rate: fxNumerator = EURC base units
 * per fxDenominator USDC base units. Pure relabeling — no division anywhere
 * (D-04); consistency is checked downstream by bigint cross-multiplication.
 */
export function quoteToRate(q: FxQuote): { fxNumerator: bigint; fxDenominator: bigint } {
  if (q.amountIn === 0n) throw new Error("quote amountIn must be nonzero");
  if (q.amountOut === 0n) throw new Error("quote amountOut must be nonzero");
  return { fxNumerator: q.amountOut, fxDenominator: q.amountIn };
}

/**
 * Deterministic demo quote near the sample's published 0.989589 EURC/USDC,
 * in 6-decimal base units. Same seed → same quote; small seeds wiggle the
 * numerator by a few base units to exercise distinct per-round rates.
 */
export function sampleQuote(seed = 0): FxQuote {
  return {
    amountIn: 1_000_000n,
    amountOut: 989_589n + BigInt(seed % 7),
    timestamp: 1_753_372_800 + seed,
  };
}
