import { join } from "node:path";
import type { ListeningPort } from "../ports/port-scan.js";
import { oneServerPerDir, panelKey } from "./panels.js";

// What a panel's preview hostname serves, not what port the daemon assigned it: a repo may bind its own ports or run
// started by hand outside PORT, so listening sockets decide and the assigned port is only a first guess. The three
// states stay distinct since the panel shows a different screen for each.

export interface PanelServer {
    readonly port: number;
    // Which package inside the panel's directory bound this port (`_editor/web`); undefined at the directory root.
    readonly dir: string | undefined;
}

export type PanelUpstream =
    // `assigned`: whether this is the port the daemon handed the process. Only an assigned port may be forwarded
    // verbatim; a self-pinned port's host check may only accept localhost.
    | { readonly state: "serving"; readonly port: number; readonly assigned: boolean }
    // Daemon-run, but nothing has bound a port yet: installing, compiling, or dying in its terminal.
    | { readonly state: "starting" }
    // Serving on several ports with no single preview port; names them all and lets the user pick.
    | { readonly state: "several"; readonly servers: readonly PanelServer[] }
    | { readonly state: "stopped" };

export type PanelUpstreamResolver = (key: string) => Promise<PanelUpstream>;

// Directory owning this panel's listeners: `<repo>`, or `<repo>/_apps/<app>` for a monorepo app. Matches by comparing
// DNS-safe keys (`panelKey`), since `--` can't be un-escaped unambiguously; undefined when no repo owns the key.
export const panelDirOf = (workspaceRoot: string, repos: readonly string[], key: string): string | undefined => {
    // Compares via `panelKey`, not a local escape: a name that can't form a hostname label never got one to claim.
    const own = repos.find((repo) => panelKey(repo) === key);
    if (own !== undefined) {
        return join(workspaceRoot, own);
    }
    const split = key.lastIndexOf("--");
    if (split <= 0) {
        return undefined;
    }
    const repo = repos.find((candidate) => panelKey(candidate) === key.slice(0, split));
    return repo === undefined ? undefined : join(workspaceRoot, repo, "_apps", key.slice(split + 2));
};

// Every dev server answering under one panel's directory, one per package (a Vite binds its HMR channel and optimizer
// from the same dir); lowest port is the app's own, sidecars take whatever ephemeral port comes next.
const serversUnder = (dir: string, siblings: readonly string[], listeners: readonly ListeningPort[]): PanelServer[] => {
    const dirs = [dir, ...siblings.filter((sibling) => sibling !== dir)].toSorted((a, b) => b.length - a.length);
    const owns = (cwd: string): boolean => dirs.find((candidate) => cwd === candidate || cwd.startsWith(`${candidate}/`)) === dir;
    return oneServerPerDir(
        listeners
            .filter((listener) => listener.forwardable && listener.cwd !== undefined && owns(listener.cwd))
            .toSorted((a, b) => a.port - b.port)
            .map((listener) => ({ port: listener.port, dir: listener.cwd === dir ? undefined : listener.cwd?.slice(dir.length + 1) })),
    );
};

// Priority order: the assigned port if it answers (checked against raw listeners, so a cwd-less socket still counts);
// else this directory's one server; else the ambiguity, named; else starting or stopped from the assignment.
export interface PanelSockets {
    // Where this panel's own processes run: `<repo>`, or `<repo>/_apps/<app>` for one app instance.
    readonly dir: string | undefined;
    // Every other directory that could claim a socket, so the most specific match wins over a nested repo.
    readonly siblings: readonly string[];
    readonly listeners: readonly ListeningPort[];
    readonly assignedPort: number | undefined;
    // Whether the assigned port already answers, for a caller that knows better than the scan.
    readonly assignedAnswers?: boolean;
}

export const resolvePanelUpstream = (panel: PanelSockets): PanelUpstream => {
    const { assignedPort } = panel;
    const assignedUp =
        panel.assignedAnswers ?? (assignedPort !== undefined && panel.listeners.some((one) => one.port === assignedPort && one.forwardable));
    if (assignedPort !== undefined && assignedUp) {
        return { state: "serving", port: assignedPort, assigned: true };
    }
    const servers = panel.dir === undefined ? [] : serversUnder(panel.dir, panel.siblings, panel.listeners);
    if (servers.length === 1 && servers[0] !== undefined) {
        return { state: "serving", port: servers[0].port, assigned: false };
    }
    if (servers.length > 1) {
        return { state: "several", servers };
    }
    return assignedPort === undefined ? { state: "stopped" } : { state: "starting" };
};

// Resolver the preview proxy holds; the procfs listener scan is cached briefly and shared across concurrent requests,
// since one page load fires many, and stays fresh enough for a newly bound port to preview almost at once.
export const createPanelUpstreamResolver = (deps: {
    readonly workspaceRoot: string;
    readonly repos: () => Promise<readonly string[]>;
    readonly listeners: () => Promise<readonly ListeningPort[]>;
    readonly portOf: (key: string) => number | undefined;
    readonly ttlMs?: number;
}): PanelUpstreamResolver => {
    const ttl = deps.ttlMs ?? 2000;
    type Snapshot = { readonly repos: readonly string[]; readonly listeners: readonly ListeningPort[] };
    let fresh: { readonly at: number; readonly snapshot: Snapshot } | undefined;
    let reading: Promise<Snapshot> | undefined;
    const state = (): Promise<Snapshot> => {
        if (fresh !== undefined && Date.now() - fresh.at <= ttl) {
            return Promise.resolve(fresh.snapshot);
        }
        // Coalesced by the in-flight read, not the window: callers within one tick share the running walk's answer.
        if (reading !== undefined) {
            return reading;
        }
        const walk = Promise.all([deps.repos(), deps.listeners()]).then(([repos, listeners]) => {
            const snapshot: Snapshot = { repos, listeners };
            // Only a successful scan is cached; a failure leaves nothing, so the next request retries instead of an
            // error.
            fresh = { at: Date.now(), snapshot };
            return snapshot;
        });
        const settled = (): void => {
            if (reading === walk) {
                reading = undefined;
            }
        };
        walk.then(settled, settled);
        reading = walk;
        return walk;
    };
    return async (key) => {
        const assigned = deps.portOf(key);
        try {
            const { repos, listeners } = await state();
            return resolvePanelUpstream({
                dir: panelDirOf(deps.workspaceRoot, repos, key),
                siblings: repos.map((repo) => join(deps.workspaceRoot, repo)),
                listeners,
                assignedPort: assigned,
            });
        } catch {
            // The scan enriches, not answers: without it, the assignment alone says whether the daemon runs this panel.
            return assigned === undefined ? { state: "stopped" } : { state: "serving", port: assigned, assigned: true };
        }
    };
};
