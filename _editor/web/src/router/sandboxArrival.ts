import type { SandboxSummary } from "@intentic/api-contract";
import { isProjectDirName } from "@intentic/sandbox-contract";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";

// `?sandbox=<id>` on a link into the workspace (`/?sandbox=<id>`): the desktop app opening the workspace on the sandbox
// it keeps a folder in sync with, or the one picked in a local window's switcher, whichever one this browser had open
// last. The id is the platform's, and it is taken only when it names a sandbox this account already lists: a link is
// not a grant, so any other is dropped. The reader who asked for it is told (`missing`): the local window lists the
// sandboxes the workspace last saw, so one removed since is a row that lands here, on the sandbox open before. Only
// the shell reads it, after the setup gate: /setup gives the same key its own meaning (the unfinished row to resume),
// and the gate has already listed the account's sandboxes by then.
//
// `&project=<folder>` beside it is the desktop app opening a project's sandbox from the folder's own window: the
// workspace opens scoped to that folder (app/projectScope.ts), whatever scope it was last left on. The daemon's hello
// names the folder too, but only the first time this browser hears it, and only from a daemon that knows to say it;
// the owner's first project opened on the `/work` around the folder, which read as "a sandbox in the parent of the
// folder I was viewing" (2026-10-05). A folder name a project cannot have is ignored, as is a project with no sandbox.

export interface SandboxArrivalHost {
    readonly list: () => Promise<readonly SandboxSummary[]>;
    /**
     * The list asked of the platform again, past any cache: a sandbox the desktop app has just made for a folder is the
     * account's before this page has heard of it, and is looked for once more before it is called gone.
     */
    readonly refresh?: () => Promise<readonly SandboxSummary[]>;
    readonly select: (id: string) => void;
    /** The named sandbox is not one this account lists, so the shell opens on the one it had open. */
    readonly missing?: () => void;
    /** Opens the named sandbox on one of its project folders (`&project=`), the folder's window having asked for it. */
    readonly scope?: (id: string, project: string) => void;
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
    const matching = (rows: readonly SandboxSummary[]): SandboxSummary | undefined => rows.find((entry) => entry.id === named);
    const found = matching(await sandbox.list()) ?? (typeof named === `string` && sandbox.refresh !== undefined ? matching(await sandbox.refresh()) : undefined);
    if (found !== undefined) {
        sandbox.select(found.id);
        const project = to.query[`project`];
        if (typeof project === `string` && isProjectDirName(project)) {
            sandbox.scope?.(found.id, project);
        }
    } else if (named !== null && !Array.isArray(named)) {
        // A key given twice, or bare, names no one sandbox, so there is none to say is gone.
        sandbox.missing?.();
    }
    const asked = to.redirectedFrom ?? to;
    const { sandbox: _dropped, project: _scoped, ...query } = asked.query;
    return { path: asked.path, query, hash: asked.hash };
};
