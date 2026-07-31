import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { extensionDir } from "../capabilities/extension-dirs.js";
import { readWorkspaceFile } from "../workspace/workspace-files.js";
import { enabledExtensions, extensionBinDirsOf, installedExtensions, listenerProvidersOf } from "./installed-extensions.js";

const manifest = (publisher: string, name: string): object => ({
    publisher,
    name,
    version: "1.0.0",
    engines: { intentic: "^0.2.0" },
});

const services = (root: string, extensionsDir: string, capabilities: Capability[]): Services =>
    ({
        workspace: { root },
        files: { read: readWorkspaceFile },
        capabilities: { list: async () => capabilities },
        config: { extensionsDir },
    }) as unknown as Services;

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

    expect(result.map((e) => ({ id: e.id, builtin: e.builtin }))).toEqual([
        { id: "intentic.discord", builtin: true },
        { id: "my-ext", builtin: false },
    ]);
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
        contributes: { listener: { provider: "discord", eventTypes: ["message", "voice_utterance"] } },
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

// Write the owner's switch file the way the enablement store does — by publisher.name, not the capability id.
const writeEnablement = async (root: string, values: Record<string, boolean>): Promise<void> => {
    await mkdir(join(root, ".intentic"), { recursive: true });
    await writeFile(join(root, ".intentic", "extension-enablement.json"), JSON.stringify(values));
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
        contributes: { bin: "bin", listener: { provider: "discord", eventTypes: ["message"] } },
    });
    await writeEnablement(root, { "intentic.discord": false });

    const host = services(root, baked, []);
    expect(await extensionBinDirsOf(host)).toEqual([]);
    expect([...(await listenerProvidersOf(host)).keys()]).toEqual([]);
});

test("an absent enablement entry means enabled — a fresh sandbox switches nothing off", async () => {
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
