import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { statePath } from "../state-paths.js";

// Where plugin checkouts live: .intentic/records/plugins/<id>, daemon-owned state beside capabilities.json, outside the
// three repos (no git-status pollution) and outside .claude/ (which Claude Code manages with its own semantics).
export const pluginsRoot = (root: string): string => statePath(root, ".intentic/records/plugins/");
export const pluginDir = (root: string, id: string): string => join(pluginsRoot(root), id);

// Each plugin capability's dir as the SDK loads it: its checkout, or `config.path` inside it for a marketplace or monorepo.
export const pluginDirsOf = (capabilities: readonly Capability[], root: string): { readonly id: string; readonly dir: string }[] =>
    capabilities.flatMap((capability) => {
        if (capability.kind !== "plugin") {
            return [];
        }
        const checkout = pluginDir(root, capability.id);
        return [{ id: capability.id, dir: capability.config.path === undefined ? checkout : join(checkout, capability.config.path) }];
    });
