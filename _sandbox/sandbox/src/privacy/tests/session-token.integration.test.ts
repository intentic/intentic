import { mkdtemp, rm } from "node:fs/promises";
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
