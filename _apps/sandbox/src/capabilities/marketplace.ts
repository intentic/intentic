import { join } from "node:path";
import type { Marketplace, MarketplacePlugin } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { CapabilityCtx } from "./capability.js";
import { gitAuthHeader } from "./handlers/plugin.js";
import { pluginsRoot } from "./plugin-dirs.js";

// The slice of .claude-plugin/marketplace.json the daemon reads — unknown fields are stripped, `source` stays
// unknown until resolveSource maps the shapes we can clone onto PluginConfig (url/ref/path).
const MarketplaceFileSchema = z.object({
    name: z.string(),
    metadata: z.object({ pluginRoot: z.string().optional() }).optional(),
    plugins: z.array(
        z.object({
            name: z.string(),
            description: z.string().optional(),
            version: z.string().optional(),
            source: z.unknown(),
        }),
    ),
});

// Map a marketplace entry's source onto an installable plugin-capability config. A relative path means the
// plugin lives inside the marketplace repo itself (metadata.pluginRoot prepends, per the Claude Code spec).
// Undefined = a source the daemon can't clone (e.g. npm) — surfaced to the UI as uninstallable, not dropped.
const resolveSource = (source: unknown, marketplaceUrl: string, pluginRoot: string | undefined): MarketplacePlugin["install"] => {
    if (typeof source === "string") {
        const relative = source.replace(/^\.\//, "");
        const path = pluginRoot !== undefined ? join(pluginRoot.replace(/^\.\//, ""), relative) : relative;
        return { url: marketplaceUrl, path };
    }
    if (typeof source !== "object" || source === null) {
        return undefined;
    }
    const s = source as { source?: string; repo?: string; url?: string; path?: string; ref?: string; sha?: string };
    // An exact sha pins harder than a ref when both are present.
    const ref = s.sha ?? s.ref;
    if (s.source === "github" && typeof s.repo === "string") {
        return { url: `https://github.com/${s.repo}.git`, ...(ref !== undefined ? { ref } : {}) };
    }
    if (s.source === "url" && typeof s.url === "string") {
        return { url: s.url, ...(ref !== undefined ? { ref } : {}) };
    }
    if (s.source === "git-subdir" && typeof s.url === "string" && typeof s.path === "string") {
        return { url: s.url, path: s.path, ...(ref !== undefined ? { ref } : {}) };
    }
    return undefined;
};

// Resolve a marketplace repo (a git repo with .claude-plugin/marketplace.json) into installable entries. The
// checkout is a throwaway read under a fixed tmp name — concurrent browses on one sandbox could collide, but a
// sandbox has one owner and the loser just retries.
export const browseMarketplace = async (ctx: CapabilityCtx, url: string, token?: string): Promise<Marketplace> => {
    const root = pluginsRoot(ctx.workspace.root);
    const tmpName = ".marketplace.tmp";
    const tmp = join(root, tmpName);
    await ctx.files.mkdir(root);
    await ctx.files.remove(tmp);
    try {
        await ctx.git.clone(root, tmpName, url, token !== undefined ? { authHeader: gitAuthHeader(token) } : undefined);
        const raw = await ctx.files.read(join(tmp, ".claude-plugin", "marketplace.json"));
        if (raw === undefined) {
            throw new Error("not a plugin marketplace: no .claude-plugin/marketplace.json in the repo");
        }
        const file = MarketplaceFileSchema.parse(JSON.parse(raw));
        return {
            name: file.name,
            plugins: file.plugins.map((plugin) => {
                const entry: MarketplacePlugin = { name: plugin.name };
                if (plugin.description !== undefined) {
                    entry.description = plugin.description;
                }
                if (plugin.version !== undefined) {
                    entry.version = plugin.version;
                }
                const install = resolveSource(plugin.source, url, file.metadata?.pluginRoot);
                if (install !== undefined) {
                    entry.install = install;
                }
                return entry;
            }),
        };
    } finally {
        await ctx.files.remove(tmp);
    }
};
