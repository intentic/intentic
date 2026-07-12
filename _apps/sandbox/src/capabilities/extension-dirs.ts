import { join } from "node:path";
import { type ExtensionManifest, ExtensionManifestSchema } from "@intentic/extension-api";
import type { Capability } from "@intentic/sandbox-contract";

// Where extension checkouts live: .intentic/extensions/<id> — daemon-owned state beside capabilities.json,
// mirroring plugin-dirs.ts (outside the three repos, outside .claude/).
export const extensionsRoot = (root: string): string => join(root, ".intentic", "extensions");
export const extensionDir = (root: string, id: string): string => join(extensionsRoot(root), id);

// The manifest's directory inside a checkout — `config.path` for extensions hosted in a marketplace/monorepo.
export const extensionRootOf = (dir: string, path: string | undefined): string => (path === undefined ? dir : join(dir, path));

// Read + validate a checkout's intentic-extension.json; undefined when absent or unparseable. Install-time
// validation already rejected bad manifests (handlers/extension.ts), so this only filters checkouts that
// rotted afterwards — callers skip those rather than fail.
export const readExtensionManifest = async (
    read: (absPath: string) => Promise<string | undefined>,
    dir: string,
): Promise<ExtensionManifest | undefined> => {
    const raw = await read(join(dir, "intentic-extension.json"));
    if (raw === undefined) {
        return undefined;
    }
    try {
        return ExtensionManifestSchema.parse(JSON.parse(raw));
    } catch {
        return undefined;
    }
};

// The absolute dirs of extension checkouts whose manifests contribute agent plugins — appended after
// pluginDirsOf wherever the SDK's `plugins` option is built. contributes.agent.path is relative to the
// extension root (itself config.path-relative inside the checkout); the SDK's loader parses the internals.
export const extensionAgentDirsOf = async (
    capabilities: readonly Capability[],
    root: string,
    read: (absPath: string) => Promise<string | undefined>,
): Promise<string[]> => {
    const dirs: string[] = [];
    for (const capability of capabilities) {
        if (capability.kind !== "extension") {
            continue;
        }
        const dir = extensionRootOf(extensionDir(root, capability.id), capability.config.path);
        const agent = (await readExtensionManifest(read, dir))?.contributes?.agent;
        if (agent === undefined) {
            continue;
        }
        dirs.push(agent.path === undefined ? dir : join(dir, agent.path));
    }
    return dirs;
};
