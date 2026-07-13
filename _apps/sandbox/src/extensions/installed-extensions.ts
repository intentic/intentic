import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionManifest, extensionIdOf } from "@intentic/extension-api";
import type { Capability } from "@intentic/sandbox-contract";
import { extensionDir, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";

// The daemon surface the extension enumerator needs — a structural subset of Services, so callers pass
// `services` directly, and the narrow capability handler ctx passes a small adapter (it has the same fields).
export interface ExtensionHost {
    readonly workspace: { readonly root: string };
    readonly files: { readonly read: (absPath: string) => Promise<string | undefined> };
    readonly capabilities: { readonly list: () => Promise<Capability[]> };
    readonly config: { readonly extensionsDir: string };
}

/* The union of git-installed extension capabilities and image-baked extensions — the single enumerator every
 * extension consumer (agent plugin dirs, processes, settings, env, the list route) iterates, so a baked
 * first-party extension (ext-discord, ext-connectors) behaves identically to one a user cloned. Baked ones live
 * under services.config.extensionsDir (EXTENSIONS_DIR), one subdir per checkout, the iq-plugin precedent
 * — no capability entry, not removable, present because they shipped in the image. */

export interface InstalledExtension {
    // The routing handle: the capability entry id for a git-installed extension, or the manifest-derived
    // publisher.name for a baked one (which has no capability entry).
    readonly id: string;
    // The manifest's directory (config.path applied for git-installed).
    readonly dir: string;
    readonly manifest: ExtensionManifest;
    // Image-baked (no clone, not removable) vs a git-installed extension capability.
    readonly builtin: boolean;
}

const bakedExtensions = async (services: ExtensionHost): Promise<InstalledExtension[]> => {
    const root = services.config.extensionsDir;
    if (root === "") {
        return [];
    }
    let names: string[];
    try {
        names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
    const found: InstalledExtension[] = [];
    for (const name of names) {
        const dir = join(root, name);
        const manifest = await readExtensionManifest(dir);
        if (manifest !== undefined) {
            found.push({ id: extensionIdOf(manifest), dir, manifest, builtin: true });
        }
    }
    return found;
};

// Baked first (a baked id shadows a git-installed collision — install already rejects the collision, so this is
// only a safety net), then the git-installed extension capabilities whose checkout still parses.
export const installedExtensions = async (services: ExtensionHost): Promise<InstalledExtension[]> => {
    const capabilities = await services.capabilities.list();
    const installed: InstalledExtension[] = [];
    for (const capability of capabilities) {
        if (capability.kind !== "extension") {
            continue;
        }
        const dir = extensionRootOf(extensionDir(services.workspace.root, capability.id), capability.config.path);
        const manifest = await readExtensionManifest(dir);
        if (manifest !== undefined) {
            installed.push({ id: capability.id, dir, manifest, builtin: false });
        }
    }
    const baked = await bakedExtensions(services);
    const bakedIds = new Set(baked.map((extension) => extension.id));
    return [...baked, ...installed.filter((extension) => !bakedIds.has(extension.id))];
};

// The absolute dirs of installed extensions whose manifests contribute agent plugins — appended after
// pluginDirsOf wherever the SDK's `plugins` option is built. contributes.agent.path is relative to the
// extension root; the SDK's loader parses the internals (skills/agents/hooks/.mcp.json).
export const extensionAgentDirsOf = async (services: ExtensionHost): Promise<string[]> => {
    const dirs: string[] = [];
    for (const extension of await installedExtensions(services)) {
        const agent = extension.manifest.contributes?.agent;
        if (agent === undefined) {
            continue;
        }
        dirs.push(agent.path === undefined ? extension.dir : join(extension.dir, agent.path));
    }
    return dirs;
};

// The absolute `bin` dirs of installed extensions that ship agent CLIs (contributes.bin) — prepended to the
// agent turn's PATH wherever the shell env is built, so a shipped tool (e.g. `discord-voice`) resolves by name.
export const extensionBinDirsOf = async (services: ExtensionHost): Promise<string[]> => {
    const dirs: string[] = [];
    for (const extension of await installedExtensions(services)) {
        const bin = extension.manifest.contributes?.bin;
        if (bin !== undefined) {
            dirs.push(join(extension.dir, bin));
        }
    }
    return dirs;
};

// Every realtime-listener provider an installed extension declares → the event types it emits
// (contributes.listener). The automations upsert validates a listener trigger against this (plus core
// `webchat`), and the listener routes serve a gateway under its provider.
export const listenerProvidersOf = async (services: ExtensionHost): Promise<Map<string, Set<string>>> => {
    const providers = new Map<string, Set<string>>();
    for (const extension of await installedExtensions(services)) {
        const listener = extension.manifest.contributes?.listener;
        if (listener !== undefined) {
            providers.set(listener.provider, new Set(listener.eventTypes));
        }
    }
    return providers;
};
