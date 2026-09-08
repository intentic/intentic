import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionManifest, extensionIdOf } from "@intentic/extension-manifest";
import type { Capability, ExtensionSummary, InvalidWorkspaceExtension } from "@intentic/sandbox-contract";
import {
    extensionDir,
    extensionRootOf,
    parseExtensionManifest,
    readExtensionManifest,
    workspaceExtensionsRoot,
} from "../capabilities/extension-dirs.js";
import { readExtensionEnablement } from "./extension-enablement.js";

// Structural subset of Services the enumerator needs; callers pass `services` or a small adapter with the same fields.
export interface ExtensionHost {
    readonly workspace: { readonly root: string };
    readonly files: { readonly read: (absPath: string) => Promise<string | undefined> };
    readonly capabilities: { readonly list: () => Promise<Capability[]> };
    readonly config: { readonly extensionsDir: string };
}

// Enumerates image-baked, git-installed, and workspace extensions as one list every consumer iterates.
// Baked ones ship in the image (UI ones manifest-only); workspace ones report a parse failure instead of skipping it.

export interface InstalledExtension {
    // Routing handle: the capability entry id for a git-installed extension, else the manifest's publisher.name.
    readonly id: string;
    // The manifest's directory (config.path applied for git-installed).
    readonly dir: string;
    readonly manifest: ExtensionManifest;
    // Where the code comes from (ExtensionSummary); a live-edited workspace dir is hashed, not sha-pinned.
    readonly source: ExtensionSummary["source"];
    // Owner's switch; a disabled extension stays listed (its row still renders) but drops from enabledExtensions().
    readonly enabled: boolean;
}

const bakedExtensions = async (services: ExtensionHost, enabledOf: (manifest: ExtensionManifest) => boolean): Promise<InstalledExtension[]> => {
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
            found.push({ id: extensionIdOf(manifest), dir, manifest, source: "builtin", enabled: enabledOf(manifest) });
        }
    }
    return found;
};

// Workspace-extension directories, plus ones that failed to be one; `taken` holds every id other sources answer for.
// A collision is reported like a parse failure, since there's no install moment to reject it at.
const workspaceExtensions = async (
    services: ExtensionHost,
    enabledOf: (manifest: ExtensionManifest) => boolean,
    taken: ReadonlySet<string>,
): Promise<{ extensions: InstalledExtension[]; invalid: InvalidWorkspaceExtension[] }> => {
    const root = workspaceExtensionsRoot(services.workspace.root);
    let names: string[];
    try {
        names = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => entry.name)
            .toSorted();
    } catch {
        return { extensions: [], invalid: [] };
    }
    const extensions: InstalledExtension[] = [];
    const invalid: InvalidWorkspaceExtension[] = [];
    const seen = new Set(taken);
    for (const name of names) {
        const dir = join(root, name);
        const result = await parseExtensionManifest(dir);
        if ("error" in result) {
            invalid.push({ dir: name, error: result.error });
            continue;
        }
        const id = extensionIdOf(result.manifest);
        if (seen.has(id)) {
            invalid.push({ dir: name, error: `the id "${id}" is already taken by another extension` });
            continue;
        }
        seen.add(id);
        extensions.push({ id, dir, manifest: result.manifest, source: "workspace", enabled: enabledOf(result.manifest) });
    }
    return { extensions, invalid };
};

// Baked first (a safety net; install already rejects the collision), then git-installed, then workspace.
// Switch is fixed on for these three: each is the sole control surface for an engine the daemon runs regardless.
// - automations: the scheduler, listeners and approval queue fire on their own.
// - workflows: advances daemon-side; the page is its only stop button.
// - maintenance: probes run on their own tick; the panel is the only visibility.
// A core list, not a manifest field, so an extension cannot grant itself this. Approvals is fail-safe, not listed.
export const ESSENTIAL_EXTENSIONS: ReadonlySet<string> = new Set(["intentic.automations", "intentic.workflows", "intentic.maintenance"]);

export const extensionInventory = async (
    services: ExtensionHost,
): Promise<{ extensions: InstalledExtension[]; invalid: InvalidWorkspaceExtension[] }> => {
    const capabilities = await services.capabilities.list();
    // Keyed by publisher.name so the switch survives remove/re-add; essential reads enabled despite a stale false.
    const enablement = await readExtensionEnablement(services.workspace.root);
    const enabledOf = (manifest: ExtensionManifest): boolean =>
        ESSENTIAL_EXTENSIONS.has(extensionIdOf(manifest)) || enablement[extensionIdOf(manifest)] !== false;
    const installed: InstalledExtension[] = [];
    for (const capability of capabilities) {
        if (capability.kind !== "extension") {
            continue;
        }
        const dir = extensionRootOf(extensionDir(services.workspace.root, capability.id), capability.config.path);
        const manifest = await readExtensionManifest(dir);
        if (manifest !== undefined) {
            installed.push({ id: capability.id, dir, manifest, source: "installed", enabled: enabledOf(manifest) });
        }
    }
    const baked = await bakedExtensions(services, enabledOf);
    const bakedIds = new Set(baked.map((extension) => extension.id));
    const pinned = [...baked, ...installed.filter((extension) => !bakedIds.has(extension.id))];
    const taken = new Set(pinned.flatMap((extension) => [extension.id, extensionIdOf(extension.manifest)]));
    const workspace = await workspaceExtensions(services, enabledOf, taken);
    return { extensions: [...pinned, ...workspace.extensions], invalid: workspace.invalid };
};

export const installedExtensions = async (services: ExtensionHost): Promise<InstalledExtension[]> => (await extensionInventory(services)).extensions;

// What the daemon actually wires up; only the list route wants the full set (a disabled row still needs its toggle).
// Every other consumer iterates this one: disabled means no plugin dir, PATH entry, listener, card, or env var.
export const enabledExtensions = async (services: ExtensionHost): Promise<InstalledExtension[]> =>
    (await installedExtensions(services)).filter((extension) => extension.enabled);

// Absolute dirs of enabled extensions contributing agent plugins, appended after pluginDirsOf in the plugins option.
// contributes.agent.path is relative to the extension root.
export const extensionAgentDirsOf = async (services: ExtensionHost): Promise<string[]> => {
    const dirs: string[] = [];
    for (const extension of await enabledExtensions(services)) {
        const agent = extension.manifest.contributes?.agent;
        if (agent === undefined) {
            continue;
        }
        dirs.push(agent.path === undefined ? extension.dir : join(extension.dir, agent.path));
    }
    return dirs;
};

// Absolute `bin` dirs of enabled extensions shipping CLIs, prepended to the turn's PATH so a tool resolves by name.
export const extensionBinDirsOf = async (services: ExtensionHost): Promise<string[]> => {
    const dirs: string[] = [];
    for (const extension of await enabledExtensions(services)) {
        const bin = extension.manifest.contributes?.bin;
        if (bin !== undefined) {
            dirs.push(join(extension.dir, bin));
        }
    }
    return dirs;
};

// Every realtime-listener provider an enabled extension declares, mapped to its event types; used by the activity feed.
// Not automations' trigger catalogue (automations/catalog.ts), which also covers the daemon's own sources.
export const listenerProvidersOf = async (services: ExtensionHost): Promise<Map<string, Set<string>>> => {
    const providers = new Map<string, Set<string>>();
    for (const extension of await enabledExtensions(services)) {
        const listener = extension.manifest.contributes?.listener;
        if (listener !== undefined) {
            providers.set(listener.provider, new Set(listener.events.map((event) => event.type)));
        }
    }
    return providers;
};
