import { coreModelRoleEntries, EXTENSION_ROLES_BEFORE_CONTRIBUTIONS, type ModelRoleEntry, ROLES_BEFORE_CONTRIBUTIONS } from "@intentic/sandbox-contract/models/model-roles";

// (2026-11-26) THE JOBS THE MODELS PAGE PLACES: the sandbox's own and each installed extension's, as the daemon serves
// them (`GET /settings/model-roles`). A daemon older than that route knew six extensions' jobs as its own and served no
// list, so for it the page lists the table it had (docs/architecture/app-plane.md, older daemons).

/** What a daemon from before contributed jobs placed: every job its table held, each switched on. */
export const rolesBeforeContributions = (): ModelRoleEntry[] =>
    ROLES_BEFORE_CONTRIBUTIONS.map((role) => {
        const extension = EXTENSION_ROLES_BEFORE_CONTRIBUTIONS.find((moved) => moved.id === role.id)?.extension;
        return extension === undefined ? { ...role, enabled: true } : { ...role, extension, enabled: true };
    });

/** The jobs the page shows: those whose extension is switched on. A switched-off one's stored choice stays as written. */
export const shownRoles = (roles: readonly ModelRoleEntry[]): readonly ModelRoleEntry[] => roles.filter((role) => role.enabled);

/** While the list is still on its way: the sandbox's own jobs, which every daemon has. */
export const coreRoles = (): readonly ModelRoleEntry[] => coreModelRoleEntries();
