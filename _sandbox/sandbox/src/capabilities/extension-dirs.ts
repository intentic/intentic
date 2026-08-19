import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionManifest, ExtensionManifestSchema } from "@intentic/extension-manifest";
import { statePath } from "../workspace/state-paths.js";

// Where GIT-INSTALLED extension checkouts live: .intentic/local/extensions/<id> — daemon-owned state beside
// capabilities.json (outside the three repos, outside .claude/). Baked extensions live at EXTENSIONS_DIR
// instead. Both are daemon-owned dirs read with a RAW fs read (extensionRead) — never the agent-facing
// workspace-scoped read, which refuses paths outside /work (where the baked dir lives).
export const extensionsRoot = (root: string): string => statePath(root, ".intentic/local/extensions/");
export const extensionDir = (root: string, id: string): string => join(extensionsRoot(root), id);

// Where WORKSPACE extensions live: one directory per extension, consumed in place — no clone, no capability
// entry, no install moment. Deliberately a sibling of the checkout root above: that one is daemon-owned and
// keyed by capability ids, this one is authored with the agent's file tools (the drafts precedent) and keyed
// by nothing but its manifest.
export const workspaceExtensionsRoot = (root: string): string => statePath(root, ".intentic/config/workspace-extensions/");

// The manifest's directory inside a checkout — `config.path` for extensions hosted in a marketplace/monorepo.
export const extensionRootOf = (dir: string, path: string | undefined): string => (path === undefined ? dir : join(dir, path));

// A raw read of a daemon-owned extension file (manifest / skill / fragment). These are real filesystem paths
// (git checkout under /work, or the baked dir at /opt/extensions), not agent-supplied, so no path-escape guard.
export const extensionRead = async (absPath: string): Promise<string | undefined> => readFile(absPath, "utf8").catch(() => undefined);

// Read + validate a directory's intentic-extension.json, KEEPING the failure. For checkouts the failure is
// only a filter (install-time validation already rejected bad manifests; a rotted one is skipped), but for a
// workspace extension it is the author's whole feedback channel — there is no install moment to reject a bad
// manifest, so the message rides the extensions list instead.
export const parseExtensionManifest = async (dir: string): Promise<{ manifest: ExtensionManifest } | { error: string }> => {
    const raw = await extensionRead(join(dir, "intentic-extension.json"));
    if (raw === undefined) {
        return { error: "no intentic-extension.json at the extension root" };
    }
    try {
        return { manifest: ExtensionManifestSchema.parse(JSON.parse(raw)) };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
};

// The filtering read for the callers that only act on directories that DO parse.
export const readExtensionManifest = async (dir: string): Promise<ExtensionManifest | undefined> => {
    const result = await parseExtensionManifest(dir);
    return "manifest" in result ? result.manifest : undefined;
};
