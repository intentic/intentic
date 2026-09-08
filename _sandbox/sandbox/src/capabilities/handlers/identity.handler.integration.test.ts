import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, IdentityConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { hasSession, markConnected } from "../../browser/sessions/session-store.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { identityHandler, identityLoginUrl } from "./identity.handler.js";

// Ctx exposing only what identityHandler touches. `capabilities` is mutable: converge derives the shared `identities`
// skill from it plus the entry mid-apply, so a second identity's converge still sees the first.
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
    }
};

const identitiesSkillPath = (root: string): string => join(root, ".agents", "skills", "identities", "SKILL.md");

test("apply lands the identity on the shared identities skill; status is pending until the provider login lands", async () => {
    const { ctx, root } = tempCtx();
    expect(await identityHandler.status(ctx, "main", config())).toEqual({ state: "inactive" });

    await drain(identityHandler.apply(ctx, "main", config()));
    const skill = await readWorkspaceFile(identitiesSkillPath(root));
    // One shared skill for every identity, never a per-identity clone.
    expect(skill).toContain("name: identities");
    expect(skill).toContain("- `main`: studio@gmail.com");
    // Tools are the routed browser server's, addressed by `account`, the id each roster line leads with.
    expect(skill).toContain("mcp__browser__browser_");
    expect(skill).toContain("`account`");
    // Explicit "NOT open accounts" beats leaving the agent to discover it via a tool refusal.
    expect(skill).toMatch(/NOT open accounts/i);

    // Pending either way; browser-pack presence changes the detail, never the state.
    expect((await identityHandler.status(ctx, "main", config())).state).toBe("pending");
});

test("the open-accounts switch flips the skill's guidance to the open_account playbook", async () => {
    const { ctx, root } = tempCtx();
    await drain(identityHandler.apply(ctx, "main", config({ openAccounts: "on" })));
    const skill = await readWorkspaceFile(identitiesSkillPath(root));
    expect(skill).toContain("open_account");
    expect(skill).toContain("- `main`: studio@gmail.com · may open accounts");
    expect(skill).not.toContain("no identity here may open accounts");
});

test("two identities are two roster lines on one skill, and each keeps its own switch wording", async () => {
    const { ctx, root, capabilities } = tempCtx();
    await drain(identityHandler.apply(ctx, "main", config()));
    capabilities.push({ id: "main", kind: "identity", config: config() });
    await drain(identityHandler.apply(ctx, "scout", config({ email: "scout@gmail.com", openAccounts: "on" })));

    const skill = await readWorkspaceFile(identitiesSkillPath(root));
    expect(skill).toContain("- `main`: studio@gmail.com · may NOT open accounts");
    expect(skill).toContain("- `scout`: scout@gmail.com · may open accounts");
    // Catalog line routes by id only; addresses stay on roster lines, since the description loads on every call.
    expect(skill).toMatch(/^description: .*\(main, scout\)/m);
    expect(skill).not.toMatch(/^description: .*@/m);
});

test("apply rejects a non-address and a dangling mailbox reference at the form, not turns later", async () => {
    const { ctx } = tempCtx();
    await expect(drain(identityHandler.apply(ctx, "main", config({ email: "not-an-email" })))).rejects.toThrow(/email address/);
    await expect(drain(identityHandler.apply(ctx, "main", config({ mailbox: "imap-main" })))).rejects.toThrow(/no capability "imap-main"/);
});

test("remove refuses while accounts still name this identity, then tears the whole session down", async () => {
    const born: Capability = { id: "reddit-main", kind: "browser", config: { platform: "reddit", identity: "main" } };
    const { ctx, root } = tempCtx([born]);
    await drain(identityHandler.apply(ctx, "main", config()));
    await markConnected(root, "main");

    await expect(identityHandler.remove?.(ctx, "main", config())).rejects.toThrow(/reddit-main/);
    expect(hasSession(root, "main")).toBe(true);

    // No account this time: removing the last identity takes the shared skill and session with it.
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
    // Unknown domain falls back to itself; an explicit loginUrl always wins.
    expect(identityLoginUrl(config({ email: "me@acme.dev" }))).toBe("https://acme.dev/");
    expect(identityLoginUrl(config({ loginUrl: "https://sso.acme.dev/start" }))).toBe("https://sso.acme.dev/start");
});
