import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { pluginDirsOf } from "../../../capabilities/plugin-dirs.js";
import type { Services } from "../../../composition.js";
import { type ExtensionHost, extensionAgentDirsOf, extensionGranted } from "../../../capabilities/extension-inventory/installed-extensions.js";
import { roleKitPlugin } from "../../../roles/role-kit.js";

// One Claude Code plugin dir a turn loads, named the way the Skills list names the skills inside it.
export interface AgentMount {
    // `builtin` is a plugin this image ships; the rest say which of the owner's things brought it.
    readonly origin: "builtin" | "plugin" | "extension" | "role";
    // What a list row's id is qualified by: the baked plugin's name, or the capability, extension or role id.
    readonly id: string;
    // Who ships it, as the list names them.
    readonly owner: string;
    readonly pluginDir: string;
    // Baked into the image (webq, a baked extension's plugin): nothing in /work changes it, so its hooks are outside
    // the approval the settings-hook gate asks for (guard/settings-hooks.ts says why the rest are not).
    readonly shipped: boolean;
}

export type MountHost = ExtensionHost & { readonly config: Pick<Services["config"], "webqPluginDir"> };

export interface MountChoice {
    // The plugin capabilities that mount: those granted to a turn, or every one the list may show.
    readonly capabilities: readonly Capability[];
    // Whose kit mounts, when its manifest exists: the role a turn wears, or every role for the list.
    readonly roles: readonly Role[];
    // Which extensions' agent plugins mount: the `extensions` shelf of the role a turn wears, or undefined (every
    // enabled one) for the list. Required, so no caller loads them all by forgetting to say.
    readonly extensions: readonly string[] | undefined;
}

const baked = (id: string, owner: string, pluginDir: string): AgentMount => ({ origin: "builtin", id, owner, pluginDir, shipped: true });

// In load order: webq first, ungated as its CLI is always on PATH, then the owner's plugins and extensions, a kit last.
export const agentMounts = async (host: MountHost, choice: MountChoice): Promise<AgentMount[]> => {
    const root = host.workspace.root;
    const [extensions, kits] = await Promise.all([
        extensionAgentDirsOf(host),
        Promise.all(choice.roles.map(async (role) => ({ role, dir: await roleKitPlugin(root, role.id) }))),
    ]);
    return [
        ...(host.config.webqPluginDir !== "" ? [baked("webq", "Web pages", host.config.webqPluginDir)] : []),
        ...pluginDirsOf(choice.capabilities, root).map(({ id, dir }): AgentMount => ({ origin: "plugin", id, owner: id, pluginDir: dir, shipped: false })),
        ...extensions.flatMap(({ id, name, dir, source }): AgentMount[] =>
            extensionGranted(choice.extensions, id) ? [{ origin: "extension", id, owner: name, pluginDir: dir, shipped: source === "builtin" }] : [],
        ),
        ...kits.flatMap(({ role, dir }): AgentMount[] =>
            dir === undefined ? [] : [{ origin: "role", id: role.id, owner: role.label ?? role.id, pluginDir: dir, shipped: false }],
        ),
    ];
};
