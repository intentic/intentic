import { webcrypto } from "node:crypto";
import { beforeAll, expect, test, vi } from "vitest";
import { EmbedError, embedFailure, embedUrl, fetchEmbedJson, solveProofOfWork } from "./embed.js";

/* The wire every embed speaks before it speaks its own, against a fake fetch and the real WebCrypto. */

// jsdom ships no SubtleCrypto; node's is the same WebCrypto the browser exposes, so the solver is exercised
// against the real digest rather than a stub.
beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

// The daemon verifies exactly this: hash the whole answer string and count the leading zero bits.
const leadingZeroBits = async (answer: string): Promise<number> => {
    const digest = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(answer)));
    let bits = 0;
    for (const byte of digest) {
        if (byte !== 0) {
            return bits + Math.clz32(byte) - 24;
        }
        bits += 8;
    }
    return bits;
};

test("a door's route is spelled the daemon's way, with the automation id encoded", () => {
    expect(embedUrl({ base: "https://sandbox.example", automationId: "a b" }, "webchat", "config")).toBe("https://sandbox.example/webchat/a%20b/config");
});

test("a refusal carries the server's own sentence and status, and a bodyless one says what it can", async () => {
    const said = await embedFailure(new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403 }));
    expect(said).toBeInstanceOf(EmbedError);
    expect(said).toMatchObject({ message: "origin not allowed", status: 403 });
    expect(await embedFailure(new Response("nope", { status: 502 }))).toMatchObject({ message: "request failed (502)", status: 502 });
});

test("a JSON fetch answers the body or throws the refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    expect(await fetchEmbedJson<{ ok: boolean }>("https://x/y")).toEqual({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })));
    await expect(fetchEmbedJson("https://x/y")).rejects.toMatchObject({ message: "rate limited", status: 429 });
    vi.unstubAllGlobals();
});

/* The one test that pays for real work: 12 bits is ~900 awaited digests, which is what carries the solver past
 * its 512-nonce batch and through the yield the page needs to keep painting. Every digest is a round trip to
 * the platform's crypto, so what that costs is set by how loaded the machine is and never by this code: hence
 * a budget that bounds a hang instead of the suite's 5s hang detector for in-memory work, which a busy runner
 * beat. The other two prove things that need no work at all, and are cheap on purpose. */
test("the answer really clears the difficulty, and carries the salt back for the daemon to re-derive", async () => {
    const answer = await solveProofOfWork({ salt: "abc123", difficulty: 12 }, "needs https");
    expect(answer.startsWith("abc123:")).toBe(true);
    expect(await leadingZeroBits(answer)).toBeGreaterThanOrEqual(12);
}, 20_000);

test("a different salt yields a different answer: a solution cannot be replayed across callers", async () => {
    const [one, two] = await Promise.all([
        solveProofOfWork({ salt: "salt-one", difficulty: 6 }, "needs https"),
        solveProofOfWork({ salt: "salt-two", difficulty: 6 }, "needs https"),
    ]);
    expect(one).not.toBe(two);
});

test("an http:// page is told the truth, in the embed's own words, instead of hanging on a missing SubtleCrypto", async () => {
    Object.defineProperty(globalThis, "crypto", { value: { randomUUID: webcrypto.randomUUID }, configurable: true });
    await expect(solveProofOfWork({ salt: "abc", difficulty: 8 }, "This page must be served over HTTPS to start a chat.")).rejects.toThrow(/HTTPS to start a chat/);
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});
