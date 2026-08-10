import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, IdentityConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { hasSession, markConnected } from "../../browser/session-store.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { identityHandler, identityLoginUrl } from "./identity.js";

// The browser handler's harness, one directory over: a ctx exposing only what identityHandler touches, on a
// fresh temp workspace. `capabilities` here carries the accounts the remove-refusal reads.
const tempCtx = (capabilities: Capability[] = []): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "identity-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => capabilities, get: async (id: string) => capabilities.find((entry) => entry.id === id) },
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

const config = (extra: Partial<IdentityConfig> = {}): IdentityConfig => ({ email: "studio@gmail.com", openAccounts: "off", ...extra });

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply writes the identity's own skill; status is pending until the provider login lands", async () => {
    const { ctx, root } = tempCtx();
    expect(await identityHandler.status(ctx, "main", config())).toEqual({ state: "inactive" });

    await drain(identityHandler.apply(ctx, "main", config()));
    const skill = await readWorkspaceFile(join(root, ".claude", "skills", "main", "SKILL.md"));
    expect(skill).toContain("name: main");
    expect(skill).toContain("studio@gmail.com");
    // The identity's browser tools carry ITS id — the prefix every account born from it will share.
    expect(skill).toContain("mcp__main__browser_");
    // The switch is off, and the skill says so out loud rather than leaving the agent to hit the tool's refusal.
    expect(skill).toContain("has NOT allowed");

    // No session yet — pending either way (with or without the browser pack, the detail differs, never the state).
    expect((await identityHandler.status(ctx, "main", config())).state).toBe("pending");
});

test("the open-accounts switch flips the skill's guidance to the open_account playbook", async () => {
    const { ctx, root } = tempCtx();
    await drain(identityHandler.apply(ctx, "main", config({ openAccounts: "on" })));
    const skill = await readWorkspaceFile(join(root, ".claude", "skills", "main", "SKILL.md"));
    expect(skill).toContain("open_account");
    expect(skill).not.toContain("has NOT allowed");
});

test("apply rejects a non-address and a dangling mailbox reference at the form, not turns later", async () => {
    const { ctx } = tempCtx();
    await expect(drain(identityHandler.apply(ctx, "main", config({ email: "not-an-email" })))).rejects.toThrow(/email address/);
    await expect(drain(identityHandler.apply(ctx, "main", config({ mailbox: "imap-main" })))).rejects.toThrow(/no capability "imap-main"/);
});

/* The refusal that keeps a shared browser from vanishing under its accounts: their sessions live in the
 * identity's profile, so removing it would sign every one of them out as a side effect. The message names the
 * accounts because the fix is per-account and the reader is about to go do it. */
test("remove refuses while accounts still name this identity, then tears the whole session down", async () => {
    const born: Capability = { id: "reddit-main", kind: "browser", config: { platform: "reddit", identity: "main" } };
    const { ctx, root } = tempCtx([born]);
    await drain(identityHandler.apply(ctx, "main", config()));
    await markConnected(root, "main");

    await expect(identityHandler.remove?.(ctx, "main", config())).rejects.toThrow(/reddit-main/);
    expect(hasSession(root, "main")).toBe(true);

    // With the account gone, removal takes the identity's skill and session with it.
    const empty = tempCtx();
    await drain(identityHandler.apply(empty.ctx, "main", config()));
    await markConnected(empty.root, "main");
    await identityHandler.remove?.(empty.ctx, "main", config());
    expect(hasSession(empty.root, "main")).toBe(false);
    expect(await readWorkspaceFile(join(empty.root, ".claude", "skills", "main", "SKILL.md"))).toBeUndefined();
});

test("the guided login starts at the provider's own sign-in, guessed from the address", () => {
    expect(identityLoginUrl(config())).toBe("https://accounts.google.com/");
    expect(identityLoginUrl(config({ email: "ops@outlook.com" }))).toBe("https://login.live.com/");
    // An unknown (hosted) domain falls back to the domain itself; an explicit loginUrl beats every guess.
    expect(identityLoginUrl(config({ email: "me@acme.dev" }))).toBe("https://acme.dev/");
    expect(identityLoginUrl(config({ loginUrl: "https://sso.acme.dev/start" }))).toBe("https://sso.acme.dev/start");
});
