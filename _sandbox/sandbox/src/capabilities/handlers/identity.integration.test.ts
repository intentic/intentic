import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, IdentityConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { hasSession, markConnected } from "../../browser/session-store.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { identityHandler, identityLoginUrl } from "./identity.js";

/* The browser handler's harness, one directory over: a ctx exposing only what identityHandler touches, on a
 * fresh temp workspace. `capabilities` carries the store the converge derives the SHARED `identities` skill
 * from — mutable, because the routes upsert after apply and the second identity's converge must still see the
 * first (the delta covers only the entry mid-apply). */
const tempCtx = (capabilities: Capability[] = []): { ctx: CapabilityCtx; root: string; capabilities: Capability[] } => {
    const root = mkdtempSync(join(tmpdir(), "identity-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => capabilities, get: async (id: string) => capabilities.find((entry) => entry.id === id) },
    } as unknown as CapabilityCtx;
    return { ctx, root, capabilities };
};

const config = (extra: Partial<IdentityConfig> = {}): IdentityConfig => ({ email: "studio@gmail.com", openAccounts: "off", ...extra });

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

const identitiesSkillPath = (root: string): string => join(root, ".agents", "skills", "identities", "SKILL.md");

test("apply lands the identity on the shared identities skill; status is pending until the provider login lands", async () => {
    const { ctx, root } = tempCtx();
    expect(await identityHandler.status(ctx, "main", config())).toEqual({ state: "inactive" });

    await drain(identityHandler.apply(ctx, "main", config()));
    const skill = await readWorkspaceFile(identitiesSkillPath(root));
    // ONE skill for every identity — never a per-identity clone — with this identity as a roster line.
    expect(skill).toContain("name: identities");
    expect(skill).toContain("- `main` — studio@gmail.com");
    // The tools are the routed browser server's, addressed by account — the id every roster line leads with.
    expect(skill).toContain("mcp__browser__browser_");
    expect(skill).toContain("`account`");
    // The switch is off, and the skill says so out loud rather than leaving the agent to hit the tool's refusal.
    expect(skill).toContain("may NOT open accounts");

    // No session yet — pending either way (with or without the browser pack, the detail differs, never the state).
    expect((await identityHandler.status(ctx, "main", config())).state).toBe("pending");
});

test("the open-accounts switch flips the skill's guidance to the open_account playbook", async () => {
    const { ctx, root } = tempCtx();
    await drain(identityHandler.apply(ctx, "main", config({ openAccounts: "on" })));
    const skill = await readWorkspaceFile(identitiesSkillPath(root));
    expect(skill).toContain("open_account");
    expect(skill).toContain("- `main` — studio@gmail.com · may open accounts");
    expect(skill).not.toContain("no identity here may open accounts");
});

test("two identities are two roster lines on one skill, and each keeps its own switch wording", async () => {
    const { ctx, root, capabilities } = tempCtx();
    await drain(identityHandler.apply(ctx, "main", config()));
    capabilities.push({ id: "main", kind: "identity", config: config() });
    await drain(identityHandler.apply(ctx, "scout", config({ email: "scout@gmail.com", openAccounts: "on" })));

    const skill = await readWorkspaceFile(identitiesSkillPath(root));
    expect(skill).toContain("- `main` — studio@gmail.com · may NOT open accounts");
    expect(skill).toContain("- `scout` — scout@gmail.com · may open accounts");
    // Both route from the one catalog line.
    expect(skill).toMatch(/^description: .*main \(studio@gmail\.com\).*scout \(scout@gmail\.com\)/m);
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

    // With the account gone, removing the LAST identity takes the shared skill and the session with it.
    const empty = tempCtx();
    await drain(identityHandler.apply(empty.ctx, "main", config()));
    await markConnected(empty.root, "main");
    await identityHandler.remove?.(empty.ctx, "main", config());
    expect(hasSession(empty.root, "main")).toBe(false);
    expect(await readWorkspaceFile(identitiesSkillPath(empty.root))).toBeUndefined();
});

test("removing one identity of two keeps the shared skill, minus its roster line", async () => {
    const scout: Capability = { id: "scout", kind: "identity", config: config({ email: "scout@gmail.com" }) };
    const { ctx, root, capabilities } = tempCtx([scout]);
    await drain(identityHandler.apply(ctx, "main", config()));
    capabilities.push({ id: "main", kind: "identity", config: config() });

    await identityHandler.remove?.(ctx, "main", config());
    const skill = await readWorkspaceFile(identitiesSkillPath(root));
    expect(skill).toContain("- `scout`");
    expect(skill).not.toContain("- `main`");
});

test("the guided login starts at the provider's own sign-in, guessed from the address", () => {
    expect(identityLoginUrl(config())).toBe("https://accounts.google.com/");
    expect(identityLoginUrl(config({ email: "ops@outlook.com" }))).toBe("https://login.live.com/");
    // An unknown (hosted) domain falls back to the domain itself; an explicit loginUrl beats every guess.
    expect(identityLoginUrl(config({ email: "me@acme.dev" }))).toBe("https://acme.dev/");
    expect(identityLoginUrl(config({ loginUrl: "https://sso.acme.dev/start" }))).toBe("https://sso.acme.dev/start");
});
