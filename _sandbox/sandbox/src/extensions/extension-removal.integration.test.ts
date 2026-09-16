import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../app.js";
import { extensionDir, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { fakeFiles } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryAutomationsStore, memoryCapabilitiesStore, memorySecretVault } from "../harness/route-stores.testing.js";
import { removeWorkspacePath } from "../workspace/files/workspace-files.js";
import { statePath } from "../workspace/layout/state-paths.js";
import { workspacePaths } from "../workspace/workspace.js";

// Removal, over the daemon's HTTP surface. The claims worth holding: the plan names the connections configured from
// the extension's own cards before anything happens, removal actually takes them, and the ledgers keyed by the
// extension's identity — which every other path keeps on purpose so they survive a re-clone — do not survive this.

const MANIFEST = {
    publisher: "acme",
    name: "toolbox",
    version: "2.1.0",
    engines: { intentic: "^0.2.0" },
    contributes: {
        settings: [
            { key: "region", title: "Region", type: "string" },
            { key: "apiKey", title: "API key", type: "string", secret: true },
        ],
        listener: {
            provider: "acme-feed",
            events: [{ type: "message", label: "A message arrives" }],
            automation: {
                label: "Acme feed",
                channel: { label: "Channel", placeholder: "#general" },
                starterPrompt: "Answer what arrived.",
            },
        },
        capabilities: [
            {
                id: "acme-cli",
                kind: "cli",
                catalog: { name: "Acme CLI", description: "Runs acme jobs", category: "tools" },
                fields: [{ key: "token", label: "Token", secret: true }],
                env: { ACME_TOKEN: "${token}" },
                skill: "skills/acme.md",
            },
        ],
    },
};

// An automation must name what it spends; nothing here fires, so the cheapest valid pin will do.
const MODELS = [{ provider: "claude" as const, model: "opus" }];

const settingsFile = (root: string): string => statePath(root, ".intentic/config/extension-settings.json");

// A workspace extension on disk plus the state an owner accumulates around one: a connection added from its card, its
// own settings (one open, one vaulted), a switch entry, and an automation waking on its listener.
const withExtension = async (cliConfig: Record<string, string> = { token: "sk-live" }) => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-remove-")));
    const dir = join(workspaceExtensionsRoot(workspace.root), "toolbox");
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(MANIFEST));
    await writeFile(join(dir, "skills", "acme.md"), "---\nname: acme\n---\nRun acme.\n");
    const settings = settingsFile(workspace.root);
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ "acme.toolbox": { region: "eu" }, "other.pack": { keep: "me" } }));
    await writeFile(
        statePath(workspace.root, ".intentic/config/extension-enablement.json"),
        JSON.stringify({ "acme.toolbox": true, "intentic.discord": false }),
    );
    const svc = services({
        workspace,
        capabilities: memoryCapabilitiesStore([
            { id: "acme", kind: "cli", config: { provider: "acme-cli", ...cliConfig } },
            // A cli from a card nobody here supplies: removal must leave it exactly where it is.
            { id: "unrelated", kind: "cli", config: { provider: "github", token: "gh" } },
        ]),
        extensionSecretVault: memorySecretVault({ "acme.toolbox": { apiKey: "sk-setting" }, "other.pack": { token: "t" } }),
        automations: memoryAutomationsStore([
            { id: "triage", trigger: { kind: "listener", provider: "acme-feed" }, prompt: "look", enabled: true, models: MODELS, runs: [] },
            { id: "nightly", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "sweep", enabled: true, models: MODELS, runs: [] },
        ]),
        // The default fake never deletes; a workspace extension's directory IS the install, so this test needs the
        // real one or it would assert against a removal that did not happen.
        files: fakeFiles({ remove: removeWorkspacePath }),
    });
    return { svc, workspace, client: clientFor(createApp(svc)) };
};

const settingsOn = async (root: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(settingsFile(root), "utf8"));

test("the removal plan names the connections, credentials and stranded automations before anything happens", async () => {
    const { client } = await withExtension();

    const plan = await client.extensions.removalPlan({ id: "acme.toolbox" });

    expect(plan).toMatchObject({ id: "acme.toolbox", name: "acme.toolbox", version: "2.1.0", source: "workspace", rebuildNeeded: false });
    expect(plan.blocked).toBeUndefined();
    // The connection configured from this extension's own card, and only that one.
    expect(plan.connections).toEqual([
        { id: "acme", kind: "cli", card: "Acme CLI", secrets: ["token"], effect: expect.stringContaining("skill file") },
    ]);
    // Both halves of what the owner typed: the open setting and the vaulted one, the latter flagged as a credential.
    expect(plan.settings.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: "apiKey", secret: true },
        { key: "region", secret: false },
    ]);
    expect(plan.files).toEqual([{ path: ".intentic/config/workspace-extensions/toolbox", detail: expect.stringContaining("source") }]);
    // Kept, not removed — and told, because a listener automation's failure is otherwise silent.
    expect(plan.automations).toEqual(["triage"]);
    expect(plan.keeps).toContain("anything it wrote in your workspace stays where it is");
});

test("removing takes the connections configured from its cards and forgets the state keyed by its identity", async () => {
    const { svc, workspace, client } = await withExtension();

    const removed = await client.extensions.remove({ id: "acme.toolbox" });
    expect(removed).toEqual({ ok: true, connections: ["acme"] });

    // The extension is gone from the list, and so is the connection that only had a card while it was here.
    expect((await client.extensions.list()).extensions.some((extension) => extension.id === "acme.toolbox")).toBe(false);
    expect((await svc.capabilities.list()).map((capability) => capability.id)).toEqual(["unrelated"]);

    // Both settings halves dropped for this extension only; another extension's row is untouched.
    expect(await settingsOn(workspace.root)).toEqual({ "other.pack": { keep: "me" } });
    expect(await svc.extensionSecretVault.all()).toEqual({ "other.pack": { token: "t" } });
    expect(JSON.parse(await readFile(join(workspace.root, ".intentic/config/extension-enablement.json"), "utf8"))).toEqual({
        "intentic.discord": false,
    });

    // The owner's automations survive, including the one that now has nothing to wake it.
    expect((await svc.automations.list()).map((automation) => automation.id).toSorted()).toEqual(["nightly", "triage"]);
});

// A disabled extension is out of the card registry, so without its own card the cli handler cannot tell a credential
// from a plain field and would report every one of them as a stored secret — the opposite of informing anybody.
test("a switched-off extension still names exactly which of a connection's fields are credentials", async () => {
    const { client } = await withExtension({ region: "eu", token: "sk-live" });
    await client.extensions.setEnabled({ id: "acme.toolbox", enabled: false });

    const plan = await client.extensions.removalPlan({ id: "acme.toolbox" });
    expect(plan.connections).toEqual([{ id: "acme", kind: "cli", card: "Acme CLI", secrets: ["token"], effect: expect.any(String) }]);
});

test("removing a git-installed extension drops its capability entry and its checkout", async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "ext-remove-installed-")));
    const checkout = extensionDir(workspace.root, "toolbox");
    await mkdir(join(checkout, "skills"), { recursive: true });
    await writeFile(join(checkout, "intentic-extension.json"), JSON.stringify(MANIFEST));
    await writeFile(join(checkout, "skills", "acme.md"), "---\nname: acme\n---\nRun acme.\n");
    const svc = services({
        workspace,
        capabilities: memoryCapabilitiesStore([
            { id: "toolbox", kind: "extension", config: { url: "https://example.test/acme.git", ref: "a".repeat(40) } },
            { id: "acme", kind: "cli", config: { provider: "acme-cli", token: "sk-live" } },
        ]),
        files: fakeFiles({ remove: removeWorkspacePath }),
    });
    const client = clientFor(createApp(svc));

    const plan = await client.extensions.removalPlan({ id: "toolbox" });
    expect(plan).toMatchObject({ id: "toolbox", name: "acme.toolbox", source: "installed" });
    expect(plan.files).toEqual([{ path: ".intentic/local/extensions/toolbox", detail: expect.stringContaining("2.1.0") }]);
    expect(plan.keeps).toContain("its source repository is untouched, so installing it again is one paste of the same address");

    expect(await client.extensions.remove({ id: "toolbox" })).toEqual({ ok: true, connections: ["acme"] });
    // Both entries gone: the extension's own, and the connection that only had a card while it was installed.
    expect(await svc.capabilities.list()).toEqual([]);
    await expect(readFile(join(checkout, "intentic-extension.json"), "utf8")).rejects.toThrow();
});

test("a built-in extension answers a plan that refuses, and refuses the removal itself", async () => {
    const client = clientFor(createApp(services({ workspace: workspacePaths(mkdtempSync(join(tmpdir(), "ext-remove-builtin-"))) })));

    const plan = await client.extensions.removalPlan({ id: "intentic.automations" });
    // Essential outranks built-in: both refuse, and the reason the owner gets is the one that is actually theirs.
    expect(plan.blocked).toContain("carries on whether the page is here or not");
    expect(await errorCode(client.extensions.remove({ id: "intentic.automations" }))).toBe("PRECONDITION_FAILED");

    const discord = await client.extensions.removalPlan({ id: "intentic.discord" });
    expect(discord.blocked).toContain("built into the sandbox image");
    expect(await errorCode(client.extensions.remove({ id: "intentic.discord" }))).toBe("PRECONDITION_FAILED");
});
