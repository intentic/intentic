import type { Capability, Persona } from "@intentic/sandbox-contract";
import { pluginDirsOf } from "../../../capabilities/plugin-dirs.js";
import type { Services } from "../../../composition.js";
import { type ExtensionHost, extensionAgentDirsOf } from "../../../extensions/installed-extensions.js";
import { personaKitPlugin } from "../../../personas/persona-kit.js";

// One Claude Code plugin dir a turn loads, named the way the Skills list names the skills inside it.
export interface AgentMount {
    // `builtin` is a plugin this image ships; the rest say which of the owner's things brought it.
    readonly origin: "builtin" | "plugin" | "extension" | "persona";
    // What a list row's id is qualified by: the baked plugin's name, or the capability, extension or persona id.
    readonly id: string;
    // Who ships it, as the list names them.
    readonly owner: string;
    readonly pluginDir: string;
}

export type MountHost = ExtensionHost & { readonly config: Pick<Services["config"], "iqPluginDir" | "webqPluginDir"> };

export interface MountChoice {
    // Whether the iq teaching loads: a turn's experiment arm, or the sandbox's own setting for the list.
    readonly iqLoaded: boolean;
    // The plugin capabilities that mount: those granted to a turn, or every one the list may show.
    readonly capabilities: readonly Capability[];
    // Whose kit mounts, when its manifest exists: the persona a turn wears, or every persona for the list.
    readonly personas: readonly Persona[];
}

const baked = (id: string, owner: string, pluginDir: string): AgentMount => ({ origin: "builtin", id, owner, pluginDir });

// In load order: iq ahead of any user plugin so code search prefers it, webq ungated as its CLI is always on PATH, a kit last.
export const agentMounts = async (host: MountHost, choice: MountChoice): Promise<AgentMount[]> => {
    const root = host.workspace.root;
    const [extensions, kits] = await Promise.all([
        extensionAgentDirsOf(host),
        Promise.all(choice.personas.map(async (persona) => ({ persona, dir: await personaKitPlugin(root, persona.id) }))),
    ]);
    return [
        ...(choice.iqLoaded && host.config.iqPluginDir !== "" ? [baked("iq", "Code search", host.config.iqPluginDir)] : []),
        ...(host.config.webqPluginDir !== "" ? [baked("webq", "Web pages", host.config.webqPluginDir)] : []),
        ...pluginDirsOf(choice.capabilities, root).map(({ id, dir }): AgentMount => ({ origin: "plugin", id, owner: id, pluginDir: dir })),
        ...extensions.map(({ id, name, dir }): AgentMount => ({ origin: "extension", id, owner: name, pluginDir: dir })),
        ...kits.flatMap(({ persona, dir }): AgentMount[] =>
            dir === undefined ? [] : [{ origin: "persona", id: persona.id, owner: persona.label ?? persona.id, pluginDir: dir }],
        ),
    ];
};
