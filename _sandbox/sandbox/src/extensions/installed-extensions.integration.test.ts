import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { listenerContribution, testConfig } from "../testing.js";
import { extensionDir, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import { approveExtension, forgetExtensionApproval } from "./extension-approvals.js";
import { enabledExtensions, extensionBinDirsOf, extensionInventory, installedExtensions, listenerProvidersOf } from "./installed-extensions.js";

const manifest = (publisher: string, name: string): object => ({
    publisher,
    name,
    version: "1.0.0",
    engines: { intentic: "^0.2.0" },
});

// Each workspace root keeps its own approvals beside it, so one test's yes is never another's.
const historyOf = (root: string): string => `${root}-history`;

const services = (root: string, extensionsDir: string, capabilities: Capability[]): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        config: { ...testConfig, extensionsDir, historyRoot: historyOf(root) },
    });

const writeManifest = async (dir: string, body: object): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(body));
};

test("enumerates baked extensions from the extensions dir and git-installed capabilities together", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    const baked = mkdtempSync(join(tmpdir(), "installed-baked-"));
    await writeManifest(join(baked, "intentic.discord"), manifest("intentic", "discord"));
    await writeManifest(extensionDir(root, "my-ext"), manifest("acme", "tool"));

    const capabilities: Capability[] = [{ id: "my-ext", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }];
    const result = await installedExtensions(services(root, baked, capabilities));

    expect(result.map((e) => ({ id: e.id, source: e.source }))).toEqual([
        { id: "intentic.discord", source: "builtin" },
        { id: "my-ext", source: "installed" },
    ]);
});

test("enumerates approved workspace extensions after the pinned sources, with their own switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    await writeManifest(join(workspaceExtensionsRoot(root), "notes"), manifest("acme", "notes"));
    await approveExtension(historyOf(root), "acme.notes", ExtensionManifestSchema.parse(manifest("acme", "notes")));
    await writeEnablement(root, { "acme.notes": false });

    const result = await extensionInventory(services(root, "", []));
    expect(result.invalid).toEqual([]);
    expect(result.extensions.map((e) => ({ id: e.id, source: e.source, enabled: e.enabled }))).toEqual([
        { id: "acme.notes", source: "workspace", enabled: false },
    ]);
    expect(result.extensions[0]?.dir).toBe(join(workspaceExtensionsRoot(root), "notes"));
});

test("a workspace directory that is not an extension is reported, not silently skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    await mkdir(join(workspaceExtensionsRoot(root), "empty"), { recursive: true });
    await mkdir(join(workspaceExtensionsRoot(root), "broken"), { recursive: true });
    await writeFile(join(workspaceExtensionsRoot(root), "broken", "intentic-extension.json"), "{");

    const result = await extensionInventory(services(root, "", []));
    expect(result.extensions).toEqual([]);
    expect(result.invalid.map((entry) => entry.dir)).toEqual(["broken", "empty"]);
    expect(result.invalid[1]?.error).toContain("no intentic-extension.json");
});

test("a workspace extension can never shadow a pinned source: the collision is reported instead", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    const baked = mkdtempSync(join(tmpdir(), "installed-baked-"));
    await writeManifest(join(baked, "intentic.discord"), manifest("intentic", "discord"));
    // Colliding on the MANIFEST identity of a git-installed extension, not its capability entry id: the
    // switch and the settings are keyed by publisher.name, so that is the identity that must stay unique.
    await writeManifest(extensionDir(root, "my-ext"), manifest("acme", "tool"));
    await writeManifest(join(workspaceExtensionsRoot(root), "impostor"), manifest("intentic", "discord"));
    await writeManifest(join(workspaceExtensionsRoot(root), "tool-again"), manifest("acme", "tool"));

    const capabilities: Capability[] = [{ id: "my-ext", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }];
    const result = await extensionInventory(services(root, baked, capabilities));
    expect(result.extensions.map((e) => e.id)).toEqual(["intentic.discord", "my-ext"]);
    expect(result.invalid.map((entry) => entry.dir)).toEqual(["impostor", "tool-again"]);
    expect(result.invalid[0]?.error).toContain("already taken");
});

test("an empty extensions dir yields only git-installed extensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    await writeManifest(extensionDir(root, "my-ext"), manifest("acme", "tool"));
    const capabilities: Capability[] = [{ id: "my-ext", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }];

    const result = await installedExtensions(services(root, "", capabilities));
    expect(result.map((e) => e.id)).toEqual(["my-ext"]);
});

test("listenerProvidersOf maps each contributes.listener provider to its declared event types", async () => {
    const baked = mkdtempSync(join(tmpdir(), "installed-baked-"));
    await writeManifest(join(baked, "intentic.discord"), {
        ...manifest("intentic", "discord"),
        contributes: { listener: listenerContribution("discord", ["message", "voice_utterance"]) },
    });
    const providers = await listenerProvidersOf(services(mkdtempSync(join(tmpdir(), "installed-work-")), baked, []));
    expect([...(providers.get("discord") ?? [])]).toEqual(["message", "voice_utterance"]);
});

test("extensionBinDirsOf resolves each contributes.bin to an absolute dir on the extension", async () => {
    const baked = mkdtempSync(join(tmpdir(), "installed-baked-"));
    await writeManifest(join(baked, "intentic.discord"), { ...manifest("intentic", "discord"), contributes: { bin: "bin" } });
    const dirs = await extensionBinDirsOf(services(mkdtempSync(join(tmpdir(), "installed-work-")), baked, []));
    expect(dirs).toEqual([join(baked, "intentic.discord", "bin")]);
});

// Write the owner's switch file the way the enablement store does: by publisher.name, not the capability id.
const writeEnablement = async (root: string, values: Record<string, boolean>): Promise<void> => {
    await mkdir(join(root, STATE_DIR, "config"), { recursive: true });
    await writeFile(join(root, STATE_DIR, "config", "extension-enablement.json"), JSON.stringify(values));
};

test("a disabled extension stays listed but drops out of enabledExtensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    const baked = mkdtempSync(join(tmpdir(), "installed-baked-"));
    await writeManifest(join(baked, "intentic.discord"), manifest("intentic", "discord"));
    await writeManifest(join(baked, "intentic.imap"), manifest("intentic", "imap"));
    await writeEnablement(root, { "intentic.discord": false });

    const host = services(root, baked, []);
    // Listed with the switch, so the Extensions tab can render a row that can be switched back on.
    expect((await installedExtensions(host)).map((e) => ({ id: e.id, enabled: e.enabled }))).toEqual([
        { id: "intentic.discord", enabled: false },
        { id: "intentic.imap", enabled: true },
    ]);
    expect((await enabledExtensions(host)).map((e) => e.id)).toEqual(["intentic.imap"]);
});

test("a disabled extension contributes no listener provider and no PATH entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    const baked = mkdtempSync(join(tmpdir(), "installed-baked-"));
    await writeManifest(join(baked, "intentic.discord"), {
        ...manifest("intentic", "discord"),
        contributes: { bin: "bin", listener: listenerContribution("discord", ["message"]) },
    });
    await writeEnablement(root, { "intentic.discord": false });

    const host = services(root, baked, []);
    expect(await extensionBinDirsOf(host)).toEqual([]);
    expect([...(await listenerProvidersOf(host)).keys()]).toEqual([]);
});

test("an absent enablement entry means enabled: a fresh sandbox switches nothing off", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    const baked = mkdtempSync(join(tmpdir(), "installed-baked-"));
    await writeManifest(join(baked, "intentic.discord"), manifest("intentic", "discord"));

    expect((await enabledExtensions(services(root, baked, []))).map((e) => e.id)).toEqual(["intentic.discord"]);
});

test("the switch is keyed by publisher.name, so it survives a git-installed extension's remove/re-add", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    // Re-added under a different capability entry id; the manifest identity is what the switch remembers.
    await writeManifest(extensionDir(root, "my-ext-again"), manifest("acme", "tool"));
    await writeEnablement(root, { "acme.tool": false });
    const capabilities: Capability[] = [{ id: "my-ext-again", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }];

    expect(await enabledExtensions(services(root, "", capabilities))).toEqual([]);
});

// A workspace extension that declares a backend, a PATH entry and a process: the powers approval is about.
const toolbox = (extra: object = {}): object => ({
    ...manifest("acme", "toolbox"),
    server: "server.js",
    contributes: { bin: "bin", processes: [{ name: "worker", command: "node worker.js", autoStart: true }] },
    ...extra,
});

test("a workspace extension nobody approved waits apart: listed with its powers, never among what runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    await writeManifest(join(workspaceExtensionsRoot(root), "toolbox"), toolbox());
    const host = services(root, "", []);

    const inventory = await extensionInventory(host);
    expect(inventory.extensions).toEqual([]);
    expect(inventory.pending.map((extension) => ({ id: extension.id, approvedBefore: extension.approval.approvedBefore }))).toEqual([
        { id: "acme.toolbox", approvedBefore: false },
    ]);
    expect(inventory.pending[0]?.approval.powers).toEqual({
        added: [
            "runs a backend bundle inside the daemon's extension host",
            `a background process "worker" (starts on boot)`,
            "puts its shipped tools on the agent's PATH",
        ],
        removed: [],
        unchanged: [],
    });
    expect(await enabledExtensions(host)).toEqual([]);
    expect(await extensionBinDirsOf(host)).toEqual([]);
});

test("approval pins the declared powers: a code edit keeps it, a new power sends it back naming what was added", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    const dir = join(workspaceExtensionsRoot(root), "toolbox");
    await writeManifest(dir, toolbox());
    const host = services(root, "", []);
    await approveExtension(historyOf(root), "acme.toolbox", ExtensionManifestSchema.parse(toolbox()));
    expect((await enabledExtensions(host)).map((extension) => extension.id)).toEqual(["acme.toolbox"]);

    // Same powers, different code and a different version: the owner's own edit loop never re-asks.
    await writeManifest(dir, { ...toolbox(), version: "1.1.0", contributes: { bin: "bin", processes: [{ name: "worker", command: "node v2.js" }] } });
    await writeFile(join(dir, "server.js"), "export const activateServer = () => {};");
    expect((await enabledExtensions(host)).map((extension) => extension.id)).toEqual(["acme.toolbox"]);

    await writeManifest(dir, toolbox({ permissions: { daemon: ["GET /secrets"] } }));
    const inventory = await extensionInventory(host);
    expect(inventory.extensions).toEqual([]);
    expect(inventory.pending[0]?.approval).toMatchObject({
        approved: false,
        approvedBefore: true,
        powers: { added: ["its backend calls the daemon route GET /secrets"], removed: [] },
    });
});

test("an approval ledger this build cannot read approves no workspace extension", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    await writeManifest(join(workspaceExtensionsRoot(root), "toolbox"), toolbox());
    await approveExtension(historyOf(root), "acme.toolbox", ExtensionManifestSchema.parse(toolbox()));
    await writeFile(join(historyOf(root), "extension-approvals.json"), "{ not json");

    const inventory = await extensionInventory(services(root, "", []));
    expect(inventory.extensions).toEqual([]);
    expect(inventory.pending.map((extension) => extension.id)).toEqual(["acme.toolbox"]);
});

test("a forgotten approval puts the extension back in the queue, whatever it declares", async () => {
    const root = mkdtempSync(join(tmpdir(), "installed-work-"));
    await writeManifest(join(workspaceExtensionsRoot(root), "toolbox"), toolbox());
    await approveExtension(historyOf(root), "acme.toolbox", ExtensionManifestSchema.parse(toolbox()));
    await forgetExtensionApproval(historyOf(root), "acme.toolbox");

    expect((await extensionInventory(services(root, "", []))).pending.map((extension) => extension.id)).toEqual(["acme.toolbox"]);
});
