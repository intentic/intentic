import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTokens } from "../gateway/session-token.js";

// The gateway forwards to whatever upstream its session names, so the signature is all that stops a URL from being
// pointed somewhere else: these pin that a session reads back exactly, survives a restart, and refuses any edit.

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "privacy-token-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("a signed session reads back exactly, and across a restart of the signer", async () => {
    const key = join(dir, "key");
    const token = await sessionTokens(key).sign({ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1" });
    expect(await sessionTokens(key).verify(token)).toEqual({ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1" });
});

// The clearing arm rides in the signature too: a runtime cannot switch its own requests' clearing on or off.
test("a session in the clearing arm says so, and one outside it carries no flag at all", async () => {
    const signer = sessionTokens(join(dir, "key"));
    const cleared = await signer.sign({ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1", clearing: true });
    expect(await signer.verify(cleared)).toEqual({
        provider: "claude",
        upstream: "https://api.anthropic.com",
        conversationId: "c-1",
        clearing: true,
    });
    const plain = await signer.sign({ provider: "claude", upstream: "https://api.anthropic.com", clearing: false });
    expect(await signer.verify(plain)).toEqual({ provider: "claude", upstream: "https://api.anthropic.com", conversationId: undefined });
});

test("an edited payload, a foreign key and a malformed token are all refused", async () => {
    const signer = sessionTokens(join(dir, "key"));
    const token = await signer.sign({ provider: "claude", upstream: "https://api.anthropic.com" });
    const [, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ p: "claude", u: "https://attacker.example" })).toString("base64url")}.${signature ?? ""}`;
    expect(await signer.verify(forged)).toBeUndefined();
    expect(await sessionTokens(join(dir, "other-key")).verify(token)).toBeUndefined();
    expect(await signer.verify("nonsense")).toBeUndefined();
    expect(await signer.verify(`${token}.extra`)).toBeUndefined();
});

// Two signers' first use of one key file (spelled two ways, so neither shares the other's in-process load) keep one key:
// whichever loses the publish reads the winner's back, so neither hands out addresses the other cannot verify.
test("two concurrent first loads of the key agree, and the key is kept root-only", async () => {
    const key = join(dir, "key");
    const [a, b] = [sessionTokens(key), sessionTokens(`${dir}/./key`)];
    const session = { provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1" };
    const [fromA, fromB] = await Promise.all([a.sign(session), b.sign(session)]);
    expect(fromA).toBe(fromB);
    expect(await sessionTokens(key).verify(fromA)).toEqual(session);
    expect(((await stat(key)).mode & 0o777).toString(8)).toBe("600");
});
