import type { SandboxSummary } from "@intentic/api-contract";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";

// `?sandbox=<id>` on a link into the workspace (`/?sandbox=<id>`): the desktop app opening the workspace on the sandbox
// it keeps a folder in sync with, whichever one this browser had open last. The id is the platform's, and it is taken
// only when it names a sandbox this account already lists: a link is not a grant, so any other is dropped as if it
// were never there. Only the shell reads it, after the setup gate: /setup gives the same key its own meaning (the
// unfinished row to resume), and the gate has already listed the account's sandboxes by then.

export interface SandboxArrivalHost {
    readonly list: () => Promise<readonly SandboxSummary[]>;
    readonly select: (id: string) => void;
}

// Selects the named sandbox before the shell mounts, so nothing connects to the one active before, then replays the
// link without the id. The replay passes the home redirect again, which already chose a landing by the old sandbox's
// role (a guest's home is its chat), and every other query key rides along.
export const arriveOnSandbox = async (to: RouteLocationNormalized, sandbox: SandboxArrivalHost): Promise<true | RouteLocationRaw> => {
    const named = to.query[`sandbox`];
    if (named === undefined) {
        return true;
    }
    const found = (await sandbox.list()).find((entry) => entry.id === named);
    if (found !== undefined) {
        sandbox.select(found.id);
    }
    const asked = to.redirectedFrom ?? to;
    const { sandbox: _dropped, ...query } = asked.query;
    return { path: asked.path, query, hash: asked.hash };
};
