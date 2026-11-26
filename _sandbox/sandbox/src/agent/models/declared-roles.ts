import { extensionIdOf } from "@intentic/extension-manifest";
import { contributedModelRole, coreModelRole, coreModelRoleEntries, type ModelRole, type ModelRoleEntry, type PresetSetup } from "@intentic/sandbox-contract/models/model-roles";
import { installedExtensions, type ExtensionHost, type InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";

// (2026-11-26) THE JOBS A MODEL SETUP CAN BE CHOSEN FOR: the sandbox's own (the contract's table), then the jobs each
// installed extension declares (`contributes.modelRoles`), read off the inventory as the watch kinds are. The settings page
// lists them (`GET /settings/model-roles`), and a run naming an extension's job resolves its suggested setup from here
// while the owner has placed none. One declaration per id: the sandbox's own wins, then the first installed, an enabled
// one over a switched-off one. An extension that is off keeps its jobs listed, switched off, so a page placing jobs
// keeps the owner's choice for them and a run core still starts by id (main's fix agent, `pipeline-fix`) still reads it.

/** Every job, the sandbox's own first, then each installed extension's in inventory order. */
export const modelRolesOf = (installed: readonly InstalledExtension[]): ModelRoleEntry[] => {
    const roles = new Map<string, ModelRoleEntry>(coreModelRoleEntries().map((role) => [role.id, role]));
    for (const extension of installed) {
        for (const declared of extension.manifest.contributes?.modelRoles ?? []) {
            const earlier = roles.get(declared.id);
            const replaces = earlier === undefined || (earlier.extension !== undefined && !earlier.enabled && extension.enabled);
            if (replaces) {
                roles.set(declared.id, contributedModelRole(declared, extensionIdOf(extension.manifest), extension.enabled));
            }
        }
    }
    return [...roles.values()];
};

export const declaredModelRoles = async (host: ExtensionHost): Promise<ModelRoleEntry[]> => modelRolesOf(await installedExtensions(host));

/**
 * The setup a job is suggested, by id: the sandbox's own job's from its table, an extension's from its declaration, or
 * undefined for a job nobody declares. An inventory that cannot be read suggests nothing rather than failing the run,
 * which then opens on its caller's model as a run on no setup does; `unread` hears why.
 */
export const declaredSuggestion = async (host: ExtensionHost, role: ModelRole, unread: (error: Error) => void): Promise<PresetSetup | undefined> => {
    const own = coreModelRole(role);
    if (own !== undefined) {
        return own.setup;
    }
    const declared = await declaredModelRoles(host).catch((error: Error) => {
        unread(error);
        return [];
    });
    return declared.find((entry) => entry.id === role)?.setup;
};
