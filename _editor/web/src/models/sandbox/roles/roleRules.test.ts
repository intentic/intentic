import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { roleSlug, roleStartDirs, rolesStartingIn } from "./roleRules";

// Rules shared by both role-card surfaces: an id differing by a hyphen upserts a different role.

describe(`roleSlug`, () => {
    it(`turns a typed name into the id it will be committed under`, () => {
        expect(roleSlug(`Refactor Crew`)).toBe(`refactor-crew`);
        expect(roleSlug(`  Docs & notes  `)).toBe(`docs-notes`);
    });

    it(`has no id for a name with nothing to slug`, () => {
        expect(roleSlug(`!!!`)).toBe(``);
    });
});

describe(`rolesStartingIn`, () => {
    const roles: Role[] = [
        { id: `docs`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `refactor`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `deep`, capabilities: [], workspace: { startIn: `intentic/_editor/web` } },
        { id: `carries`, capabilities: [], context: { repos: [`intentic/_editor`] } },
        { id: `anywhere`, capabilities: [] },
    ];

    it(`finds every role that starts in the folder`, () => {
        expect(rolesStartingIn(roles, `intentic/_editor`).map((role) => role.id)).toEqual([`docs`, `refactor`]);
    });

    // Exact match only: a subfolder's role, or one that only carries this repo via `context.repos`, is not this
    // folder's.
    it(`claims neither a subfolder's role nor one that only carries the repo`, () => {
        const found = rolesStartingIn(roles, `intentic/_editor`).map((role) => role.id);
        expect(found).not.toContain(`deep`);
        expect(found).not.toContain(`carries`);
    });

    it(`counts the roles per folder in one pass, ignoring the rootless ones`, () => {
        expect(roleStartDirs(roles)).toEqual(
            new Map([
                [`intentic/_editor`, 2],
                [`intentic/_editor/web`, 1],
            ]),
        );
    });
});
