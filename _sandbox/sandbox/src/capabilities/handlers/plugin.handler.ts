import type { PluginConfig } from "@intentic/sandbox-contract";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";
import { checkoutInto } from "../git-checkout.js";
import { pluginDir, pluginsRoot } from "../plugin-dirs.js";

// A Claude Code plugin: the daemon owns the git checkout at .intentic/records/plugins/<id>; the Agent SDK's plugin
// loader reads its internals (skills/agents/hooks/commands/.mcp.json, a hooks module) each turn, see pluginDirsOf.
// Pinned like an extension: the branch, tag or commit it is added at resolves to a full commit, stored as `commit`, and
// every later apply of the stored entry (a rotated token) checks out that commit again. Adding it anew, which the form
// does without a `commit`, is the explicit update to whatever its ref names now (2026-10-04: following the branch on
// every re-apply moved code that runs inside the agent's session without anyone choosing it). The clone/checkout run in
// the visible job session the first frame surfaces.
export const pluginHandler: CapabilityHandler = {
    secret: (config) => ((config as PluginConfig).token !== undefined ? "token" : undefined),
    echo: (config) => {
        const plugin = config as PluginConfig;
        return {
            url: plugin.url,
            ...(plugin.ref !== undefined ? { ref: plugin.ref } : {}),
            ...(plugin.path !== undefined ? { path: plugin.path } : {}),
            ...(plugin.commit !== undefined ? { commit: plugin.commit } : {}),
            hasToken: plugin.token !== undefined,
        };
    },
    // `reapply: false` because this kind's apply is an INSTALL, not a write: re-running it would clone the
    // repository again over the network to end up with the bytes already on disk. Moving the checkout is the
    // whole rename, the plugin loader enumerates these directories, so it reads the new name next turn.
    rename: {
        reapply: false,
        carry: async (ctx, from, to) => ctx.files.move(pluginDir(ctx.workspace.root, from), pluginDir(ctx.workspace.root, to)),
    },
    async *apply(ctx, id, config) {
        const { url, ref, commit, token } = config as PluginConfig;
        const at = commit ?? ref;
        const session = capabilityJobSession(id);
        if (ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        yield { kind: "log", message: `Cloning ${url}${at !== undefined ? ` @ ${at}` : ""}…` };
        await checkoutInto(ctx, session, pluginsRoot(ctx.workspace.root), id, { url, ref: at, token });
        yield {
            kind: "log",
            message:
                "Plugin installed at this commit, the agent loads its skills, agents and hooks next turn. Hooks and hooks modules run once you approve them.",
        };
    },
    // The commit the checkout landed on, in full: what the entry pins from now on.
    installed: async (ctx, id, config) => ({ ...(config as PluginConfig), commit: await ctx.git.fullHead(pluginDir(ctx.workspace.root, id)) }),
    // The short HEAD sha is the version identity, the daemon never parses plugin internals (plugin.json is
    // optional anyway). A missing/broken checkout probes as inactive; re-adding repairs it.
    status: async (ctx, id) => {
        try {
            return { state: "active", detail: await ctx.git.head(pluginDir(ctx.workspace.root, id)) };
        } catch {
            return { state: "inactive" };
        }
    },
    remove: async (ctx, id) => {
        await ctx.files.remove(pluginDir(ctx.workspace.root, id));
    },
};
