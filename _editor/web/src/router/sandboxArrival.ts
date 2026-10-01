import type { SandboxSummary } from "@intentic/api-contract";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";

// `?sandbox=<id>` on a link into the workspace (`/?sandbox=<id>`): the desktop app opening the workspace on the sandbox
// it keeps a folder in sync with, or the one picked in a local window's switcher, whichever one this browser had open
// last. The id is the platform's, and it is taken only when it names a sandbox this account already lists: a link is
// not a grant, so any other is dropped. The reader who asked for it is told (`missing`): the local window lists the
// sandboxes the workspace last saw, so one removed since is a row that lands here, on the sandbox open before. Only
// the shell reads it, after the setup gate: /setup gives the same key its own meaning (the unfinished row to resume),
// and the gate has already listed the account's sandboxes by then.

export interface SandboxArrivalHost {
    readonly list: () => Promise<readonly SandboxSummary[]>;
    readonly select: (id: string) => void;
    /** The named sandbox is not one this account lists, so the shell opens on the one it had open. */
    readonly missing?: () => void;
}

/** What the rule reads of a route: a guard's route and one the router resolved for the desktop app alike (index.ts). */
export type SandboxArrivalRoute = Pick<RouteLocationNormalized, `path` | `query` | `hash` | `redirectedFrom`>;

// Selects the named sandbox before the shell mounts, so nothing connects to the one active before, then replays the
// link without the id. The replay passes the home redirect again, which already chose a landing by the old sandbox's
// role (a guest's home is its chat), and every other query key rides along.
export const arriveOnSandbox = async (to: SandboxArrivalRoute, sandbox: SandboxArrivalHost): Promise<true | RouteLocationRaw> => {
    const named = to.query[`sandbox`];
    if (named === undefined) {
        return true;
    }
    const found = (await sandbox.list()).find((entry) => entry.id === named);
    if (found !== undefined) {
        sandbox.select(found.id);
    } else if (named !== null && !Array.isArray(named)) {
        // A key given twice, or bare, names no one sandbox, so there is none to say is gone.
        sandbox.missing?.();
    }
    const asked = to.redirectedFrom ?? to;
    const { sandbox: _dropped, ...query } = asked.query;
    return { path: asked.path, query, hash: asked.hash };
};
