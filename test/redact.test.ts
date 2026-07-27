import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import type { PublicClient, WalletClient } from "viem";
import type { HubClient } from "../src/client.js";
import { agents, ANVIL_MNEMONIC } from "../demo/agents.js";
import { Coordinator } from "../demo/coordinator.js";
import { redactSensitive, redactedMessage } from "../demo/redact.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const NOW = 1_700_000_000n;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A real viem HttpRequestError message shape: the full request URL — including
 * the provider's path-embedded API token — plus a calldata blob. This is
 * exactly what reached the wire before the fix (audit E-CR-01/E-CR-02).
 */
const TOKEN_HOST = "rpc.testnet.arc-node.example.com";
const TOKEN_SEGMENT = "swrm_9f3ac1d0e77b4a2f8c6e5b1d";
const VIEM_ERROR_MESSAGE =
  "HTTP request failed.\n\n" +
  "Status: 401\n" +
  `URL: https://${TOKEN_HOST}/v1/${TOKEN_SEGMENT}\n` +
  'Request body: {"method":"eth_call","params":[{"to":"0x1111111111111111111111111111111111111111",' +
  '"data":"0x70a08231000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266"}]}';

/** No endpoint or token survived — asserted on anything reaching a caller. */
function expectNoEndpoint(s: string) {
  expect(s).not.toContain("https://");
  expect(s).not.toContain(TOKEN_HOST);
  expect(s).not.toContain(TOKEN_SEGMENT);
}

/** Additionally no key-shaped hex — asserted on REDACTED ERROR TEXT only.
 * Structured `/state` fields (agent addresses, round tx hashes) are public by
 * design and never pass through the sanitizer. */
function expectClean(s: string) {
  expectNoEndpoint(s);
  expect(s).not.toMatch(/0x[0-9a-fA-F]{40,}/);
}

describe("redactSensitive", () => {
  it("strips a token-bearing URL from a viem transport error", () => {
    // Guard: the fixture really does carry the credential pre-redaction.
    expect(VIEM_ERROR_MESSAGE).toContain(TOKEN_SEGMENT);

    const out = redactSensitive(VIEM_ERROR_MESSAGE);
    expectClean(out);
    expect(out).toContain("<rpc-url redacted>");
    expect(out).toContain("<hex redacted>");
    // Diagnostic context that carries no secret survives.
    expect(out).toContain("HTTP request failed.");
    expect(out).toContain("Status: 401");
  });

  it("strips ws/wss endpoints, bearer tokens and keyed secrets", () => {
    expect(redactSensitive("transport wss://node.example.com/ws/abc123 closed")).toBe(
      "transport <rpc-url redacted> closed",
    );
    expect(redactSensitive("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(redactSensitive("api_key=k1v2n3m4b5")).toBe("api_key=<redacted>");
    expect(redactSensitive("mnemonic: correcthorse")).toBe("mnemonic: <redacted>");
  });

  it("strips key-shaped hex with and without the 0x prefix", () => {
    const pk = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    expect(redactSensitive(`signer 0x${pk} rejected`)).toBe("signer <hex redacted> rejected");
    expect(redactSensitive(`raw ${pk} rejected`)).toBe("raw <hex redacted> rejected");
    // Addresses are 40 hex digits — also stripped: a 64-hex private key and a
    // 64-hex digest are indistinguishable, so error text loses both.
    expect(redactSensitive("hub 0x1111111111111111111111111111111111111111 paused")).toBe(
      "hub <hex redacted> paused",
    );
  });

  it("strips a BIP-39-shaped word run", () => {
    const m = "test test test test test test test test test test test junk";
    expect(redactSensitive(`invalid mnemonic ${m}`)).toContain("<mnemonic redacted>");
    expect(redactSensitive(`invalid mnemonic ${m}`)).not.toContain("junk");
  });

  it("is idempotent and leaves secret-free text alone", () => {
    const once = redactSensitive(VIEM_ERROR_MESSAGE);
    expect(redactSensitive(once)).toBe(once);

    const benign =
      "pass 2 incomplete: 1 timeout(s), 0 refusal(s) — attempt aborted (D-03)";
    expect(redactSensitive(benign)).toBe(benign);
    const benign2 =
      "previous submission still unconfirmed — refusing to start a new round (CONS-04)";
    expect(redactSensitive(benign2)).toBe(benign2);
  });

  it("redactedMessage handles non-Error throws", () => {
    expect(redactedMessage(new Error(VIEM_ERROR_MESSAGE))).toContain("<rpc-url redacted>");
    expectClean(redactedMessage(`fetch failed https://${TOKEN_HOST}/v1/${TOKEN_SEGMENT}`));
  });
});

/**
 * Boundary 1 — the HTTP 500 body. `demo/server.ts` runs `setup()` at import
 * time (spawns anvil / reaches the RPC), so it cannot be imported into a unit
 * test. Assert the sink expression itself, plus that the catch-all is wired to
 * it and no longer stringifies a raw message.
 */
describe("boundary: HTTP error response", () => {
  const source = readFileSync(join(REPO, "demo", "server.ts"), "utf8");

  it("serializes only the redacted message", () => {
    const body = JSON.stringify({ error: redactedMessage(new Error(VIEM_ERROR_MESSAGE)) });
    expectClean(body);
    expect(JSON.parse(body).error).toContain("<rpc-url redacted>");
  });

  it("wires the catch-all through the sanitizer", () => {
    expect(source).toContain("redactedMessage(e)");
    expect(source).not.toMatch(/JSON\.stringify\(\{\s*error:\s*msg/);
  });
});

/**
 * Boundary 2 — `GET /state`. A failing round must not pin the credential into
 * `lastError`, which is served unauthenticated and painted by every dashboard.
 */
describe("boundary: coordinator lastError / GET /state", () => {
  const personas = agents(ANVIL_MNEMONIC);

  function coordinatorThatFails(message: string) {
    const hubClient = {
      earliestBlock: 0n,
      roundNonce: async () => {
        throw new Error(message);
      },
      collateral: async () => 0n,
    } as unknown as HubClient;
    const pub = {
      getBlockNumber: async () => 0n,
      getContractEvents: async () => [],
    } as unknown as PublicClient;
    return new Coordinator(HUB, hubClient, pub, personas, {} as WalletClient, 31337);
  }

  it("redacts the transport error before it becomes durable state", async () => {
    const c = coordinatorThatFails(VIEM_ERROR_MESSAGE);
    await expect(c.runRound(NOW)).rejects.toThrow(/HTTP request failed/); // raw error still propagates to the operator

    expect(c.phase).toBe("failed");
    expect(c.lastError).toBeDefined();
    expectClean(c.lastError!);
    expect(c.lastError).toContain("<rpc-url redacted>");

    const state = await c.state(NOW);
    expectNoEndpoint(JSON.stringify(state));
    expectClean(state.lastError ?? "");
    expect(state.lastError).toContain("<rpc-url redacted>");
  });

  it("redacts the abort reason returned by POST /round", async () => {
    // The WrongRoundNonce marker is classified on the RAW message; the reason
    // that goes on the wire must still be sanitized.
    const c = coordinatorThatFails(`WrongRoundNonce probing ${VIEM_ERROR_MESSAGE}`);
    const out = await c.runRound(NOW);
    expect(out.outcome).toBe("aborted");
    if (out.outcome !== "aborted") return;
    expect(out.reason).toContain("WrongRoundNonce");
    expectClean(JSON.stringify(out));
  });
});
