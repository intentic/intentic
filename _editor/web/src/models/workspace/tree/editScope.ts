import { type Fence, fenceAllows } from "@intentic/sandbox-contract/policy/fence-paths";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { MemberSelf } from "@intentic/sandbox-contract/schemas/members";
import { type MemberRole, roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";

// WHERE THE SIGNED-IN PERSON MAY CHANGE FILES BY HAND, as folders: the daemon's own answer (the sandbox's
// areas/area-scope.ts `callerEditFence`) over the same facts, so a write verb is offered exactly where it will be taken.
// A writer's `edit` names areas, which the areas manifest turns into folders; a folder grants its whole subtree.
// Undefined is everywhere the person sees (the tree already lists nothing else); `[]` is nowhere.

/**
 * The edit fence for a tier, the person's own access answer, and the areas manifest. Anything not known yet answers
 * nowhere, so a write verb stays out until it is: a writer's answer still on its way, or the manifest its areas name.
 */
export const editFenceOf = (role: MemberRole, self: Pick<MemberSelf, "edit"> | undefined, areas: readonly Area[] | undefined): Fence => {
    if (roleAtLeast(role, `maintainer`)) {
        return undefined;
    }
    if (!roleAtLeast(role, `writer`) || self === undefined || self.edit === `none`) {
        return [];
    }
    if (self.edit === `all`) {
        return undefined;
    }
    if (areas === undefined) {
        return [];
    }
    const byId = new Map(areas.map((area) => [area.id, area]));
    return [...new Set(self.edit.flatMap((id) => byId.get(id)?.folders ?? []))];
};

/** Whether the fence lets the person change `path` (workspace-relative; "" is the root) or anything under it. */
export const fenceWrites = (fence: Fence, path: string): boolean => fenceAllows(fence, path);

/**
 * The fence in force for the copy on screen: the person's own on the shared tree, nowhere on anything else (a
 * conversation's private copy, a branch), which the daemon only ever reads.
 */
export const viewFence = (fence: Fence, shared: boolean): Fence => (shared ? fence : []);

/** Whether the fence lets the person change anything at all. */
export const writesSomewhere = (fence: Fence): boolean => fence === undefined || fence.length > 0;
