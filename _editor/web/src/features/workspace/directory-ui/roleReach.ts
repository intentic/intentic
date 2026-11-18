import { sandboxRef } from "@intentic/extension-api";
import { type Fence, fenceIntersection } from "@intentic/sandbox-contract/policy/fence-paths";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// "Viewing as" lens: shows what a role's folder fence actually resolves to. A card's fence is access: the areas of the
// access profiles that list it, held together, as the daemon resolves it (roles.ts roleFence).
// A lens, not a permission — it dims, never blocks, the real user. Doesn't model the sandbox write-only rule
// (no three-state dimming); mirrors role-scope.ts, comparing by path segment so `apps/web2` isn't inside `apps/web`.

// Which role the explorer reads as, or nobody; module-level since the toolbar, tree and banner aren't in one
// subtree. A role card is one sandbox's, so a switch reads as nobody again.
export const lensRoleId = sandboxRef<string | undefined>(() => undefined);

// Is `path` at or below `folder`? Both workspace-relative, forward-slashed, no trailing slash.
const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);
// Is `path` a folder you must pass through to reach `folder`? These stay lit rather than dimmed.
const leadsTo = (path: string, folder: string): boolean => folder.startsWith(`${path}/`);

// What the lens reads a card's access from: the sandbox's profiles and the areas they name.
export interface RoleAccess {
    readonly profiles: readonly Pick<AccessProfile, "areas" | "tools" | "roles">[];
    readonly areas: readonly Pick<Area, "id" | "folders">[];
}

export interface RoleReach {
    /** The folders its access fences it to, for the banner. Empty ⇒ the whole workspace. */
    readonly folders: readonly string[];
    /** True when this role's file tools would be refused this path outright. */
    readonly refuses: (path: string) => boolean;
    /** A card whose access gives it no file access reaches nothing at all, whatever its folders say. */
    readonly readsNothing: boolean;
}

const foldersOf = (areas: RoleAccess["areas"], named: readonly string[]): string[] => [
    ...new Set(named.flatMap((id) => areas.find((area) => area.id === id)?.folders ?? [])),
];

export const reachOf = (role: Pick<Role, "id">, access: RoleAccess): RoleReach => {
    const held = access.profiles.filter((profile) => profile.roles?.includes(role.id) === true);
    // A profile naming areas none of which exist fences it to nothing, which the lens draws as reading nothing.
    const fence = held.reduce<Fence>(
        (at, profile) => (profile.areas === undefined ? at : fenceIntersection(at, foldersOf(access.areas, profile.areas))),
        undefined,
    );
    const folders = fence ?? [];
    const readsNothing = held.some((profile) => profile.tools?.files === `none`) || fence?.length === 0;
    return {
        folders,
        readsNothing,
        refuses: (path: string): boolean => {
            if (readsNothing) {
                return true;
            }
            if (folders.length === 0) {
                return false;
            }
            return !folders.some((folder) => within(path, folder) || leadsTo(path, folder));
        },
    };
};

// Whether the role the explorer reads as would be refused `path`; nothing is while nobody is read as.
export const lensRefuses = (roles: readonly Pick<Role, "id">[], path: string, access: RoleAccess): boolean => {
    const role = roles.find((candidate) => candidate.id === lensRoleId.value);
    return role !== undefined && reachOf(role, access).refuses(path);
};

// The lens as a card: "Viewing as" first, the fact a reader forgetting why the tree looks odd needs, then who and where.
export const reachTip = (name: string, reach: RoleReach): Tip => {
    const role = { label: t(`workspace.words.role`), value: name };
    if (reach.readsNothing) {
        return { title: t(`workspace.workspaceDesktop.viewing`), tone: `warning`, rows: [role], note: t(`workspace.roleReach.noFileAccess`) };
    }
    if (reach.folders.length === 0) {
        return { title: t(`workspace.workspaceDesktop.viewing`), rows: [role, { label: t(`shared.folders`), value: t(`workspace.roleReach.everywhere`) }] };
    }
    return {
        title: t(`workspace.workspaceDesktop.viewing`),
        rows: [role, { label: t(`shared.folders`), value: reach.folders.join(`, `) }],
        note: t(`workspace.roleReach.dimmedRefused`),
    };
};
