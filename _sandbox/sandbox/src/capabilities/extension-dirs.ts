import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { type ExtensionManifest, ExtensionManifestSchema } from "@intentic/extension-manifest";
import { statePath } from "../workspace/layout/state-paths.js";

// Git-installed extension checkouts live at .intentic/local/extensions/<id>; baked extensions live at EXTENSIONS_DIR.
// Both use the raw extensionRead, never the workspace-scoped read that refuses paths outside /work.
export const extensionsRoot = (root: string): string => statePath(root, ".intentic/local/extensions/");
export const extensionDir = (root: string, id: string): string => join(extensionsRoot(root), id);

// Workspace extensions live here, one dir per extension, consumed in place with no clone, capability entry, or install
// moment. Authored by the agent's tools, keyed only by its manifest.
export const workspaceExtensionsRoot = (root: string): string => statePath(root, ".intentic/config/workspace-extensions/");

// Directory holding an extension's manifest: the checkout root, or the checkout root joined with `config.path` in a
// marketplace/monorepo.
export const extensionRootOf = (dir: string, path: string | undefined): string => (path === undefined ? dir : join(dir, path));

// Raw read of a daemon-owned extension file (manifest/skill/fragment): real filesystem paths (checkout under /work, or
// /opt/extensions), never agent-supplied, so no path-escape guard.
export const extensionRead = async (absPath: string): Promise<string | undefined> => readFile(absPath, "utf8").catch(() => undefined);

// Reads and validates intentic-extension.json, keeping the failure: a checkout treats it as a filter, but a workspace
// extension (no install moment) surfaces it as the author's only feedback.
export const parseExtensionManifest = async (dir: string): Promise<{ manifest: ExtensionManifest } | { error: string }> => {
    const raw = await extensionRead(join(dir, "intentic-extension.json"));
    if (raw === undefined) {
        return { error: "no intentic-extension.json at the extension root" };
    }
    try {
        return { manifest: ExtensionManifestSchema.parse(JSON.parse(raw)) };
    } catch (error) {
        return { error: errorMessage(error) };
    }
};

// Discards the error, for callers that only care about directories that parse.
export const readExtensionManifest = async (dir: string): Promise<ExtensionManifest | undefined> => {
    const result = await parseExtensionManifest(dir);
    return "manifest" in result ? result.manifest : undefined;
};
