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

// The daemon surface the extension enumerator needs — a structural subset of Services, so callers pass
// `services` directly, and the narrow capability handler ctx passes a small adapter (it has the same fields).
export interface ExtensionHost {
    readonly workspace: { readonly root: string };
    readonly files: { readonly read: (absPath: string) => Promise<string | undefined> };
    readonly capabilities: { readonly list: () => Promise<Capability[]> };
    readonly config: { readonly extensionsDir: string };
}

/* The union of image-baked, git-installed and workspace extensions — the single enumerator every extension
 * consumer (agent plugin dirs, processes, settings, env, the list route) iterates, so a baked first-party
 * extension (ext-discord, ext-connectors) behaves identically to one a user cloned or one an agent wrote into
 * the workspace. Baked ones live under services.config.extensionsDir (EXTENSIONS_DIR), one subdir per checkout,
 * the iq-plugin precedent — no capability entry, not removable, present because they shipped in the image. The
 * web-builtin UI extensions bake their MANIFEST ONLY (the code is compiled into the web bundle). Workspace ones
 * live under .intentic/workspace-extensions/, one subdir per extension, consumed in place — no capability entry
 * and no install moment, which is why their parse failures are reported (extensionInventory) rather than
 * silently skipped. So every extension enumerates here and the Extensions tab is a complete list rather than a
 * view of one load path. */

export interface InstalledExtension {
    // The routing handle: the capability entry id for a git-installed extension, or the manifest-derived
    // publisher.name for a baked or workspace one (which have no capability entry).
    readonly id: string;
    // The manifest's directory (config.path applied for git-installed).
    readonly dir: string;
    readonly manifest: ExtensionManifest;
    // Where the code comes from — see ExtensionSummary. A workspace extension's dir is live-edited, so unlike
    // the sha-pinned sources its code has no immutable identity (the bundle route hashes the bytes instead).
    readonly source: ExtensionSummary["source"];
    // The owner's switch (extension-enablement.json). A disabled extension stays in THIS list — the Extensions
    // tab needs its row to render the toggle — and drops out of enabledExtensions(), which is what every
    // consumer that actually wires something up iterates.
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

/* The workspace-extension directories, and the ones that failed to be an extension. `taken` carries every
 * identity the other two sources already answer for — route ids AND manifest identities, because the switch and
 * the settings are keyed by publisher.name whatever the route id is — so a workspace extension can never shadow
 * a baked or installed one. The refusal is REPORTED, like a parse failure: with no install moment to reject it,
 * the list is where the author learns the id is the problem rather than the manifest. */
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

// Baked first (a baked id shadows a git-installed collision — install already rejects the collision, so this is
// only a safety net), then the git-installed extension capabilities whose checkout still parses, then the
// workspace extensions. Every row carries the owner's switch; nothing is filtered here (see enabledExtensions).
// `invalid` is workspace-only by construction: the other sources were validated at bake or install time.
export const extensionInventory = async (
    services: ExtensionHost,
): Promise<{ extensions: InstalledExtension[]; invalid: InvalidWorkspaceExtension[] }> => {
    const capabilities = await services.capabilities.list();
    // Keyed by publisher.name, not the capability entry id, so the switch survives a remove/re-add.
    const enablement = await readExtensionEnablement(services.workspace.root);
    const enabledOf = (manifest: ExtensionManifest): boolean => enablement[extensionIdOf(manifest)] !== false;
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

/* What the daemon actually wires up. Only the Extensions tab (via the list route) wants the full set — a
 * disabled extension has to keep its row to keep its toggle. Everything below, and every consumer outside this
 * file, iterates THIS one, which is what makes the switch mean something: no agent plugin dir, no PATH entry,
 * no listener provider, no connector card, no env var, no autoStart process. */
export const enabledExtensions = async (services: ExtensionHost): Promise<InstalledExtension[]> =>
    (await installedExtensions(services)).filter((extension) => extension.enabled);

// The absolute dirs of installed extensions whose manifests contribute agent plugins — appended after
// pluginDirsOf wherever the SDK's `plugins` option is built. contributes.agent.path is relative to the
// extension root; the SDK's loader parses the internals (skills/agents/hooks/.mcp.json).
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

// The absolute `bin` dirs of installed extensions that ship agent CLIs (contributes.bin) — prepended to the
// agent turn's PATH wherever the shell env is built, so a shipped tool (e.g. `discord-voice`) resolves by name.
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

// Every realtime-listener provider an installed extension declares → the event types it emits
// (contributes.listener). The automations upsert validates a listener trigger against this (plus core
// `webchat`), and the listener routes serve a gateway under its provider.
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
