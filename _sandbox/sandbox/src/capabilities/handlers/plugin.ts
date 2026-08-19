import type { PluginConfig } from "@intentic/sandbox-contract";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";
import { checkoutInto } from "../git-checkout.js";
import { pluginDir, pluginsRoot } from "../plugin-dirs.js";

// A Claude Code plugin: the daemon owns the git checkout at .intentic/records/plugins/<id>; the Agent SDK's plugin
// loader reads its internals (skills/agents/hooks/commands/.mcp.json) each turn — see pluginDirsOf. Apply is an
// upsert: re-adding re-clones, which is also how a plugin updates. The clone/checkout run in the visible job
// session the first frame surfaces.
export const pluginHandler: CapabilityHandler = {
    secret: (config) => ((config as PluginConfig).token !== undefined ? "token" : undefined),
    echo: (config) => {
        const plugin = config as PluginConfig;
        return {
            url: plugin.url,
            ...(plugin.ref !== undefined ? { ref: plugin.ref } : {}),
            ...(plugin.path !== undefined ? { path: plugin.path } : {}),
            hasToken: plugin.token !== undefined,
        };
    },
    // `reapply: false` because this kind's apply is an INSTALL, not a write: re-running it would clone the
    // repository again over the network to end up with the bytes already on disk. Moving the checkout is the
    // whole rename — the plugin loader enumerates these directories, so it reads the new name next turn.
    rename: {
        reapply: false,
        carry: async (ctx, from, to) => ctx.files.move(pluginDir(ctx.workspace.root, from), pluginDir(ctx.workspace.root, to)),
    },
    apply: async function* (ctx, id, config) {
        const { url, ref, token } = config as PluginConfig;
        const session = capabilityJobSession(id);
        if (ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        yield { kind: "log", message: `Cloning ${url}${ref !== undefined ? ` @ ${ref}` : ""}…` };
        await checkoutInto(ctx, session, pluginsRoot(ctx.workspace.root), id, { url, ref, token });
        yield { kind: "log", message: "Plugin installed — the agent loads its skills, agents and hooks next turn." };
    },
    // The short HEAD sha is the version identity — the daemon never parses plugin internals (plugin.json is
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
