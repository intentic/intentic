import type { Role, TurnBriefingNoteId } from "@intentic/sandbox-contract/schemas/roles";

// Rules shared by both role-card surfaces (the full editor and the workspace tree's quick panel): the id a name
// becomes, what is worth committing, and folder membership. Pure functions, independent of useRoles. What a role
// may reach is not here: it is an access profile listing the card (Access ▸ Profiles).

// The id is derived from the name once, at creation, then frozen: automations pin to it, and renaming the label
// later does not change it.
export const roleSlug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 60);

// Which preamble notes a role drops, as a list the form can splice; empty covers both "drops none" and a role written
// before the question existed.
export const omittedNotesOf = (role: Role): TurnBriefingNoteId[] => [...(role.briefing?.omit ?? [])];

// Roles whose `workspace.startIn` matches `dir` exactly; a role that only carries the repo via `context.repos`
// does not count, nor does a subfolder's role.
export const rolesStartingIn = (roles: readonly Role[], dir: string): Role[] =>
    roles.filter((role) => role.workspace?.startIn === dir);

// Counts roles per `startIn` folder in one pass, for the tree to query per row without refiltering every role.
export const roleStartDirs = (roles: readonly Role[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const role of roles) {
        const dir = role.workspace?.startIn;
        if (dir !== undefined && dir !== ``) {
            counts.set(dir, (counts.get(dir) ?? 0) + 1);
        }
    }
    return counts;
};
