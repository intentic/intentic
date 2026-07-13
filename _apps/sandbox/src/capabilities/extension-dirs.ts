import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionManifest, ExtensionManifestSchema } from "@intentic/extension-api";

// Where GIT-INSTALLED extension checkouts live: .intentic/extensions/<id> — daemon-owned state beside
// capabilities.json (outside the three repos, outside .claude/). Baked extensions live at EXTENSIONS_DIR
// instead. Both are daemon-owned dirs read with a RAW fs read (extensionRead) — never the agent-facing
// workspace-scoped read, which refuses paths outside /work (where the baked dir lives).
export const extensionsRoot = (root: string): string => join(root, ".intentic", "extensions");
export const extensionDir = (root: string, id: string): string => join(extensionsRoot(root), id);

// The manifest's directory inside a checkout — `config.path` for extensions hosted in a marketplace/monorepo.
export const extensionRootOf = (dir: string, path: string | undefined): string => (path === undefined ? dir : join(dir, path));

// A raw read of a daemon-owned extension file (manifest / skill / fragment). These are real filesystem paths
// (git checkout under /work, or the baked dir at /opt/extensions), not agent-supplied, so no path-escape guard.
export const extensionRead = async (absPath: string): Promise<string | undefined> => readFile(absPath, "utf8").catch(() => undefined);

// Read + validate a checkout's intentic-extension.json; undefined when absent or unparseable. Install-time
// validation already rejected bad manifests (handlers/extension.ts), so this only filters checkouts that
// rotted afterwards — callers skip those rather than fail.
export const readExtensionManifest = async (dir: string): Promise<ExtensionManifest | undefined> => {
    const raw = await extensionRead(join(dir, "intentic-extension.json"));
    if (raw === undefined) {
        return undefined;
    }
    try {
        return ExtensionManifestSchema.parse(JSON.parse(raw));
    } catch {
        return undefined;
    }
};
