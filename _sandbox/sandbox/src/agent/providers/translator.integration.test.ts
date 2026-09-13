import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage } from "@intentic/sandbox-contract";
import { afterEach, expect, test, vi } from "vitest";
import { createCliProxyClient } from "./translator.js";

// `accounts` falls back to the auth-dir files on disk when the proxy is unreachable, rather than reporting empty. Uses
// a real auth dir (not translator.test.ts) since what's pinned is how it reads the files a live sandbox accumulates.

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

// Every client here is pointed at a port nothing is listening on, with fetch rejecting: the situation itself.
const clientOver = (authDir: string) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    return createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        authDir,
        usageStore: memoryStore(),
        // Pinned true rather than probed, so the assertions test the fallback, not the runner's PATH.
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
        "antigravity-user.json": JSON.stringify({ type: "antigravity", email: "user@gmail.com", project_id: "google-project" }),
        "codex-someone.json": JSON.stringify({ type: "codex", email: "someone@example.com" }),
        // Not credentials: a half-written login file, and JSON that isn't a credential shape.
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
    const authDir = authDirWith({ "antigravity-nameless.json": JSON.stringify({ type: "antigravity", project_id: "google-project" }) });

    expect(
        await clientOver(authDir)
            .accounts()
            .then((accounts) => accounts.gemini),
    ).toEqual([{ name: "antigravity-nameless.json", label: "antigravity-nameless.json" }]);
});

// The credential file is the only place the project can be read while the proxy is down, so the disk view carries it:
// judging a Google account project-less because nothing answered would bench the whole fleet on a restart.
test("reads a Google credential's project off disk, and benches only the one that has none", async () => {
    const authDir = authDirWith({
        "antigravity-onboarded.json": JSON.stringify({ type: "antigravity", email: "user@gmail.com", project_id: "google-project" }),
        "antigravity-fresh.json": JSON.stringify({ type: "antigravity", email: "fresh@gmail.com" }),
    });

    const gemini = await clientOver(authDir)
        .accounts()
        .then((accounts) => accounts.gemini);

    expect(gemini.find((account) => account.name === "antigravity-onboarded.json")).not.toHaveProperty("cooling");
    expect(gemini.find((account) => account.name === "antigravity-fresh.json")).toMatchObject({
        cooling: { reason: "no Antigravity project on this Google account" },
    });
});

// CLIProxyAPI writes the credential file, answers the callback, and lists it a beat later. A sign-in judged on the
// listing alone therefore reported success for a file it could already read as dead on disk, and that credential stayed
// in the rotation until something else swept it — long enough to kill the turns it was connected for.
test("judges the credential a sign-in just wrote, before the proxy's listing catches up with it", async () => {
    const authDir = authDirWith({ "antigravity-fresh.json": JSON.stringify({ type: "antigravity", email: "fresh@gmail.com" }) });
    const patched: unknown[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith("/auth-files/status")) {
                patched.push(JSON.parse(String(init?.body)));
            }
            // The proxy has the file on disk and not yet in the list it answers with.
            return url.endsWith("/auth-files") ? Response.json({ files: [] }) : Response.json({ status: "ok" });
        }),
    );
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        authDir,
        usageStore: memoryStore(),
    });

    const failure = client.complete({ provider: "gemini", redirectUrl: "http://localhost:51121/oauth-callback?code=abc", state: "xyz" });

    await expect(failure).rejects.toThrow(/fresh@gmail\.com.*no Antigravity project/s);
    expect(patched).toEqual([{ name: "antigravity-fresh.json", disabled: true }]);
});

test("refuses to report a disconnect the unreachable proxy never performed", async () => {
    const authDir = authDirWith({ "antigravity-user.json": JSON.stringify({ type: "antigravity", email: "user@gmail.com" }) });

    await expect(clientOver(authDir).disconnect("gemini", "antigravity-user.json")).rejects.toThrow(/starting up/);
});
