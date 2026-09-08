import type { SandboxSummary } from "@intentic/api-contract";
import type { RouteLocationRaw } from "vue-router";

// Whether this account has a workspace to open or an unfinished setup to return to. True once any
// sandbox's lastSeenAt is non-null (set by the daemon's announce or sandbox.attach); a merely down sandbox still
// counts.
export const setupRedirect = (sandboxes: readonly SandboxSummary[]): RouteLocationRaw | undefined => {
    if (sandboxes.some((entry) => entry.lastSeenAt !== null)) {
        return undefined;
    }
    // Only the owner's unfinished sandbox is resumed; a member can't mint a setup code for someone else's.
    const unfinished = sandboxes.find((entry) => entry.role === `owner`);
    return unfinished === undefined ? `/setup` : { path: `/setup`, query: { sandbox: unfinished.id } };
};
