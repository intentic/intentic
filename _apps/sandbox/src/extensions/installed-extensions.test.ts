import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { extensionDir } from "../capabilities/extension-dirs.js";
import { readWorkspaceFile } from "../workspace/workspace-files.js";
import { installedExtensions } from "./installed-extensions.js";

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
