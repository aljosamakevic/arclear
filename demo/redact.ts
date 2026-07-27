/**
 * Secret redaction for anything that can reach an unauthenticated HTTP caller.
 *
 * The hosted demo runs with `ARC_RPC_URL` pointing at a provider endpoint whose
 * API token lives in the URL PATH. viem embeds the full request URL in
 * `HttpRequestError` / `RpcRequestError` messages (`URL: ${getUrl(url)}`), and
 * `getUrl` strips only basic-auth credentials — a path-embedded token survives
 * verbatim. Two sinks used to put that message on the wire: the server's
 * catch-all 500 body and `Coordinator.lastError`, which `GET /state` serves to
 * every visitor and the dashboard renders (audit 2026-07-27, E-CR-01/E-CR-02).
 *
 * This is the single sanitizer applied at BOTH sinks. Full detail is kept in
 * server-side `console.error` only.
 *
 * Deliberately over-broad: an unredacted credential on a public endpoint costs
 * more than a redacted diagnostic. In particular 0x-hex runs of 40+ digits are
 * stripped, which also removes tx hashes and IOU ids from ERROR TEXT — a
 * 64-hex private key is indistinguishable from a 64-hex digest. Structured
 * fields (`round.txHash`, `phaseDetail` on a confirmed round, agent addresses)
 * do NOT pass through here, so the dashboard's ArcScan links are unaffected.
 */

/** http/https/ws/wss URL — the whole thing, token path segments included. */
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\]+/gi;

/** `Authorization: Bearer …` and friends. */
const SCHEME_RE = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** `token=…`, `api_key: …`, `mnemonic=…` — value up to the next delimiter. */
const KEYED_RE =
  /\b(api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd|pwd|private[-_]?key|mnemonic|seed[-_]?phrase)(\s*[=:]\s*)"?[^\s"'`,;)&]{4,}"?/gi;

/** 0x-prefixed hex >= 40 digits: private keys, hashes, calldata blobs. */
const HEX_0X_RE = /\b0x[0-9a-fA-F]{40,}\b/g;

/** Bare (unprefixed) hex >= 64 digits: a raw private key printed without 0x. */
const HEX_BARE_RE = /\b[0-9a-fA-F]{64,}\b/g;

/** 12+ consecutive short lowercase words: a BIP-39 mnemonic shape. */
const MNEMONIC_RE = /\b(?:[a-z]{3,8}[ \t]+){11,}[a-z]{3,8}\b/g;

/** Opaque high-entropy run (>= 24 chars, letters AND digits): API tokens. */
const TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Strip credential-shaped substrings. Total, pure, and idempotent — safe to
 * apply more than once along a path, and safe to apply to text that contains
 * no secrets (it only ever removes).
 */
export function redactSensitive(msg: string): string {
  return msg
    .replace(URL_RE, "<rpc-url redacted>")
    .replace(SCHEME_RE, "$1 <redacted>")
    .replace(KEYED_RE, "$1$2<redacted>")
    .replace(HEX_0X_RE, "<hex redacted>")
    .replace(HEX_BARE_RE, "<hex redacted>")
    .replace(MNEMONIC_RE, "<mnemonic redacted>")
    .replace(TOKEN_RE, (run) =>
      /[0-9]/.test(run) && /[A-Za-z]/.test(run) ? "<token redacted>" : run,
    );
}

/** `redactSensitive` over an unknown thrown value. */
export function redactedMessage(e: unknown): string {
  return redactSensitive(e instanceof Error ? e.message : String(e));
}
