import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";

// Where plugin checkouts live: .intentic/plugins/<id> — daemon-owned state beside capabilities.json, outside the
// three repos (no git-status pollution) and outside .claude/ (which Claude Code manages with its own semantics).
export const pluginsRoot = (root: string): string => join(root, ".intentic", "plugins");
export const pluginDir = (root: string, id: string): string => join(pluginsRoot(root), id);

// The absolute plugin dirs handed to the SDK `plugins` option each turn, derived from plugin-kind capabilities
// like mcpToolsOf/cliEnvOf. `config.path` = the plugin's subdirectory inside the checkout, for plugins hosted
// inside a marketplace/monorepo.
export const pluginDirsOf = (capabilities: readonly Capability[], root: string): string[] =>
    capabilities.flatMap((capability) =>
        capability.kind === "plugin"
            ? [capability.config.path !== undefined ? join(pluginDir(root, capability.id), capability.config.path) : pluginDir(root, capability.id)]
            : [],
    );
