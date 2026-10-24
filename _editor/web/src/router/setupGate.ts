import type { SandboxSummary } from "@intentic/api-contract";
import type { RouteLocationRaw } from "vue-router";
import { isAccountPath, isHomePath } from "../lib/routes/home";

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

export interface SetupGateHost {
    readonly list: () => Promise<readonly SandboxSummary[]>;
    readonly refresh: () => Promise<readonly SandboxSummary[]>;
}

// The desktop app may have made or connected a sandbox while this page was hidden. A cached list that has nothing
// to open must be confirmed before sending the reader to setup; otherwise the next fresh list leaves them on setup
// offering a sandbox that already works. A failed refresh remains a platform outage, never an empty account.
export const readSetupRedirect = async (sandbox: SetupGateHost, path = ``, authenticated = true): Promise<RouteLocationRaw | undefined> => {
    // Anonymous home has no account registry to read; its add action is where sign-in begins.
    if (!authenticated && isHomePath(path)) {
        return undefined;
    }
    const redirect = setupRedirect(await sandbox.list()) === undefined ? undefined : setupRedirect(await sandbox.refresh());
    // Home, personal settings and deleted sandboxes belong to the account, including before its first sandbox.
    return isAccountPath(path) ? undefined : redirect;
};
