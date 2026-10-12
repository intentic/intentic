import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { createApp } from "../app.js";
import { workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import { approveExtension } from "../extensions/extension-approvals.js";
import { extensionInventory } from "../extensions/installed-extensions.js";
import { approveHookSet, gateSettingsHooks } from "../guard/hook-approvals.js";
import type { HookPlace } from "../guard/settings-hooks.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { fileSafetyPolicyStore } from "../safety/safety-policy-store.js";
import { commandPolicyLines, memoryOwnerGrants } from "../personas/owner-grants.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";

// The Access tab's What you have allowed, over the daemon's HTTP surface: the yeses that name no conversation sit in one
// list whichever store keeps them, and one door takes each back with the effect taking it back should have.

const MANIFEST = { publisher: "acme", name: "toolbox", version: "1.0.0", engines: { intentic: "^0.2.0" }, server: "dist/server.js" };
const LINE = "Deleting build directories under /work is fine.";
const NOBODY_READS_MODULES = async (): Promise<never> => {
    throw new Error("no module was expected");
};

const withOwnerWideYeses = async () => {
    const base = mkdtempSync(join(tmpdir(), "owner-wide-"));
    const workspace = workspacePaths(join(base, "work"));
    const historyRoot = join(base, "history");
    const place: HookPlace = { cwd: join(base, "cwd"), home: join(base, "home"), configDir: join(base, "home", ".claude"), readable: (path) => path };
    await mkdir(join(place.cwd, ".claude"), { recursive: true });
    await writeFile(
        join(place.cwd, ".claude", "settings.json"),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } }),
    );
    const dir = join(workspaceExtensionsRoot(workspace.root), "toolbox");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(MANIFEST));

    // The clock is the line's alone to set: the list orders by when each yes was given.
    const svc = services({ workspace, config: { ...testConfig, historyRoot }, ownerGrants: memoryOwnerGrants(() => 300) });
    await approveExtension(historyRoot, "acme.toolbox", ExtensionManifestSchema.parse(MANIFEST), 400);
    const found = await gateSettingsHooks(historyRoot, place, undefined, NOBODY_READS_MODULES, 200);
    await approveHookSet(historyRoot, found.set?.digest ?? "", 200);
    await svc.ownerGrants.allowCommandPolicy(LINE, "ada@acme.dev");
    return { svc, historyRoot, place, digest: found.set?.digest ?? "", client: clientFor(createApp(svc)) };
};

test("the list holds every owner-wide yes, whichever store keeps it, and an empty sandbox lists none", async () => {
    const { client, digest } = await withOwnerWideYeses();
    const listed = await client.needs.grants();

    expect(listed.conversations).toEqual([]);
    expect(listed.unreadable).toEqual([]);
    expect(listed.ownerWide).toEqual([
        { kind: "extension", id: "acme.toolbox", powers: ["runs a backend bundle inside the daemon's extension host"], at: 400 },
        { kind: "command-policy", line: LINE, at: 300, by: "ada@acme.dev" },
        { kind: "hook-set", digest, hooks: ["PreToolUse (Bash): ./guard.sh"], at: 200 },
    ]);

    expect((await clientFor(createApp(services())).needs.grants()).ownerWide).toEqual([]);
});

test("taking back a policy line takes it out of what the judge reads from then on", async () => {
    const { client, svc } = await withOwnerWideYeses();
    const policy = fileSafetyPolicyStore(join(mkdtempSync(join(tmpdir(), "owner-wide-policy-")), "safety.md"), commandPolicyLines(svc.ownerGrants, () => undefined));
    expect(await policy.text()).toContain(`- ${LINE}`);

    expect(await client.needs.revokeGrant({ kind: "command-policy", what: LINE })).toEqual({ ok: true });

    expect(await policy.text()).not.toContain(LINE);
    expect((await client.needs.grants()).ownerWide.map((grant) => grant.kind)).toEqual(["extension", "hook-set"]);
    expect(await errorCode(client.needs.revokeGrant({ kind: "command-policy", what: LINE }))).toBe("NOT_FOUND");
});

test("taking back a hook set unapproves exactly that set, and the next turn to find it holds and asks again", async () => {
    const { client, historyRoot, place, digest } = await withOwnerWideYeses();
    expect((await gateSettingsHooks(historyRoot, place, undefined, NOBODY_READS_MODULES)).held).toBe(false);

    expect(await client.needs.revokeGrant({ kind: "hook-set", what: digest })).toEqual({ ok: true });

    expect((await gateSettingsHooks(historyRoot, place, undefined, NOBODY_READS_MODULES)).held).toBe(true);
    expect((await client.approvals.hookRequests()).requests.map((request) => request.digest)).toEqual([digest]);
    expect(await errorCode(client.needs.revokeGrant({ kind: "hook-set", what: digest }))).toBe("NOT_FOUND");
});

// The least surprising way out of an approved extension: back to waiting for the yes it waited for before, nothing deleted.
test("taking back an extension sends it back to waiting for a yes and deletes none of it", async () => {
    const { client, svc } = await withOwnerWideYeses();
    expect((await extensionInventory(svc)).extensions.map((extension) => extension.id)).toContain("acme.toolbox");

    expect(await client.needs.revokeGrant({ kind: "extension", what: "acme.toolbox" })).toEqual({ ok: true });

    const inventory = await extensionInventory(svc);
    expect(inventory.extensions.map((extension) => extension.id)).not.toContain("acme.toolbox");
    expect(inventory.pending.map((extension) => [extension.id, extension.approval.approvedBefore, extension.approval.approved])).toEqual([["acme.toolbox", false, false]]);
    expect((await client.needs.grants()).ownerWide.map((grant) => grant.kind)).toEqual(["command-policy", "hook-set"]);
    expect(await errorCode(client.needs.revokeGrant({ kind: "extension", what: "acme.toolbox" }))).toBe("NOT_FOUND");
});

test("a conversation's yes and an owner-wide one of the same word never meet", async () => {
    const { client, svc } = await withOwnerWideYeses();
    await svc.conversationGrants.add("conv-1", { subject: "folder", what: LINE }, "ada@acme.dev");
    // The conversation kind still needs its conversation; an owner-wide kind never takes one.
    expect(await errorCode(client.needs.revokeGrant({ conversationId: "conv-1", kind: "folder", what: "elsewhere" }))).toBe("NOT_FOUND");
    expect(await client.needs.revokeGrant({ kind: "command-policy", what: LINE })).toEqual({ ok: true });
    expect((await client.needs.grants()).conversations).toMatchObject([{ conversationId: "conv-1", folders: [LINE] }]);
});
