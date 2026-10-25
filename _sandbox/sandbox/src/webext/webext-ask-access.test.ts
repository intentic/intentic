import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { accessAsked, signedInInstead, type SignedInInsteadDeps } from "./webext-peer.js";

// Which of the messages bound for a person's browser is its agent asking for a site, and what the chat's card says.

test("an ask_access call names its site and reason", () => {
    expect(
        accessAsked({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask_access", arguments: { origin: "https://github.com", reason: "to read the PR checks" } } }),
    ).toEqual({ origin: "https://github.com", reason: "to read the PR checks" });
});

test("every other message is not one, and neither is an ask with no site", () => {
    expect(accessAsked({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read", arguments: { tab: 1 } } })).toBeUndefined();
    expect(accessAsked({ jsonrpc: "2.0", id: 6, method: "tools/list" })).toBeUndefined();
    expect(accessAsked({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_access", arguments: { reason: "no site" } } })).toBeUndefined();
    expect(accessAsked(undefined)).toBeUndefined();
});

// 2026-10-25: two X automations raised "Allow x.com in your browser" while the sandbox's `x` account sat signed in.
describe("a site ask a signed-in sandbox account already covers", () => {
    const granted = new Map<string, readonly string[]>([
        ["c-x", ["x"]],
        ["c-gh", ["x"]],
        ["c-none", []],
    ]);
    const x: Capability = { id: "x", kind: "browser", config: { platform: "x" } };
    const services: SignedInInsteadDeps = {
        turnGranted: (conversationId) => granted.get(conversationId),
        capabilities: { get: async (id: string) => (id === "x" ? x : undefined) },
        accountSignInUrls: async () => ["https://x.com/i/flow/login", "https://x.com/home"],
    };

    it("is answered with the account, and nothing goes up for the owner", async () => {
        const instead = await signedInInstead(services, { origin: "https://x.com" }, "c-x");
        expect(instead).toContain("Not asked");
        expect(instead).toContain('`account: "x"`');
    });

    it("asks as always for a site no held account covers, or a conversation holding none", async () => {
        expect(await signedInInstead(services, { origin: "https://github.com" }, "c-gh")).toBeUndefined();
        expect(await signedInInstead(services, { origin: "https://x.com" }, "c-none")).toBeUndefined();
        expect(await signedInInstead(services, { origin: "https://x.com" }, undefined)).toBeUndefined();
        expect(await signedInInstead(services, undefined, "c-x")).toBeUndefined();
    });
});
