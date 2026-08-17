import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { createCliProxyClient } from "./translator.js";

/* A DOWN PROXY IS NOT AN EMPTY SHELF.
 *
 * `accounts` is both the Agent tab's connection list and the routed turn's credential gate, and it used to answer
 * a proxy it couldn't reach with four empty arrays. So during the proxy's 15s boot warm-up, and on every rung of
 * its restart ladder up to a five-minute ceiling, a sandbox holding connected Google subscriptions told its owner
 * they had never signed in — and told their turns there was nothing to run on. The tokens were on disk the whole
 * time; that is where the answer comes from now when the proxy is silent.
 *
 * Here rather than in translator.test.ts because these two need a REAL auth-dir: the behaviour under test is a
 * directory read, and the one thing worth pinning about it is what it does with the files a live sandbox actually
 * accumulates — a credential, another provider's credential, a half-written one, and something that isn't one. */

const memoryStore = () => {
    const snapshots: Record<string, AccountUsage> = {};
    return {
        read: async () => snapshots,
        record: async (account: string, usage: AccountUsage) => {
            snapshots[account] = usage;
        },
        clear: async (account: string) => {
            delete snapshots[account];
        },
    };
};

// Every client here is pointed at a port nothing is listening on, with fetch rejecting — the situation itself.
const clientOver = (authDir: string) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    return createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        authDir,
        usageStore: memoryStore(),
        // The binary IS in this image; what is missing is a proxy answering on the port. Pinned rather than probed
        // so the assertions below are about the fallback and not about the runner's PATH.
        binaryPresent: async () => true,
    });
};

const authDirWith = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "cliproxy-authdir-"));
    for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body);
    }
    return dir;
};

afterEach(() => vi.unstubAllGlobals());

test("lists the subscriptions on disk when the management API cannot be reached", async () => {
    const authDir = authDirWith({
        "antigravity-user.json": JSON.stringify({ type: "antigravity", email: "user@gmail.com" }),
        "codex-someone.json": JSON.stringify({ type: "codex", email: "someone@example.com" }),
        // Not credentials: a file half-written by a login still polling, and a JSON that is none of our business.
        "half-written.json": "{",
        "notes.json": JSON.stringify({ type: "something-else" }),
    });

    const accounts = await clientOver(authDir).accounts();

    expect(accounts.gemini).toEqual([{ name: "antigravity-user.json", label: "user@gmail.com" }]);
    expect(accounts.codex).toEqual([{ name: "codex-someone.json", label: "someone@example.com" }]);
    expect(accounts.grok).toEqual([]);
    expect(accounts.kimi).toEqual([]);
});

test("names the account by its file when the credential carries no email", async () => {
    const authDir = authDirWith({ "antigravity-nameless.json": JSON.stringify({ type: "antigravity" }) });

    // A row with no label at all is a row the user cannot tell from any other, so the file name stands in.
    expect(await clientOver(authDir).accounts().then((accounts) => accounts.gemini)).toEqual([
        { name: "antigravity-nameless.json", label: "antigravity-nameless.json" },
    ]);
});

test("refuses to report a disconnect the unreachable proxy never performed", async () => {
    const authDir = authDirWith({ "antigravity-user.json": JSON.stringify({ type: "antigravity", email: "user@gmail.com" }) });

    /* The proxy holds the credential in memory as well as on disk, so deleting the file behind its back would
     * leave a live account serving turns off a token the user believes they just revoked. Now that the row is
     * visible while the proxy is down, this is reachable — and a swallowed DELETE would report success and change
     * nothing. */
    await expect(clientOver(authDir).disconnect("gemini", "antigravity-user.json")).rejects.toThrow(/starting up/);
});
