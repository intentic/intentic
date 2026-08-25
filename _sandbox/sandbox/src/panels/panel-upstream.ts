import { join } from "node:path";
import type { ListeningPort } from "../ports/port-scan.js";
import { oneServerPerDir, panelKey } from "./panels.js";

/* WHAT A PANEL'S PREVIEW HOSTNAME ACTUALLY SERVES, which is a different question from "what port did the daemon
 * assign it".
 *
 * The panel manager picks a free port, injects it as PORT, and the preview proxy used to forward there and
 * nowhere else. That holds for a scaffolded app, whose dev server reads PORT, and is fiction for two ordinary
 * shapes:
 *
 *   · A repo whose `dev` fans a turbo run out across packages that each PIN their own port (a committed dev
 *     cert's origin, a CORS allowlist, an OAuth client's redirect). It binds three real ports and none of them
 *     is the assigned one, so `preview-<repo>` dialed a port nothing was listening on and 502'd for as long as
 *     the repo ran, while the repo reported healthy (health counts listening sockets, which are real).
 *   · A dev server somebody started in their own terminal. Nothing assigned it anything, yet the repo is
 *     plainly answering, and the repo's own preview hostname is the address a user expects to reach it at.
 *
 * So the listening sockets decide, and the assigned port is only the FIRST guess among them. The three answers
 * a hostname can carry are all here rather than collapsed into "up/down", because the panel above shows a
 * different screen for each and the honest one is never an iframe pointed at a 502. */

export interface PanelServer {
    readonly port: number;
    // Which package inside the panel's directory bound it (`_editor/web`), absent when the process sits at the
    // directory itself. The only thing that tells a monorepo's three dev servers apart at a glance.
    readonly dir: string | undefined;
}

export type PanelUpstream =
    // Dial this. `assigned` is whether it is the port the daemon handed the process, which decides whether the
    // preview hostname may be forwarded verbatim: a server we started expects it (the scaffolded templates
    // allow it), one that pinned its own port is an arbitrary app whose host check only knows localhost.
    | { readonly state: "serving"; readonly port: number; readonly assigned: boolean }
    // The daemon runs it and nothing has bound a port yet: installing, compiling, or dying in its terminal.
    | { readonly state: "starting" }
    // It is serving, on several ports at once, and no single one of them is "the" preview. Naming them is the
    // whole answer here: the user picks, this proxy must not.
    | { readonly state: "several"; readonly servers: readonly PanelServer[] }
    | { readonly state: "stopped" };

export type PanelUpstreamResolver = (key: string) => Promise<PanelUpstream>;

/* WHOSE LISTENERS ARE THIS PANEL'S, by directory: `<repo>` for a repo's own panel, `<repo>/_apps/<app>` for one
 * app instance of a monorepo. The key is the DNS-safe form (`/` → `--`, see panels.ts panelKey), so a repo is
 * matched by comparing keys rather than by un-escaping, which cannot be done unambiguously; only if no repo
 * claims the key is it read as `<repoKey>--<app>`. Undefined when no repo in the workspace owns it. */
export const panelDirOf = (workspaceRoot: string, repos: readonly string[], key: string): string | undefined => {
    // `panelKey`, not a local escape: a repo whose name can't be a hostname label never had a preview name
    // minted for it, so it must not answer for one that merely escapes to the same string.
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

/* Every dev server answering inside one panel's directory, one per package (a Vite binds its HMR channel and
 * its dependency optimizer from the same dir; listing those turns one answer into a menu of three), lowest port
 * first, which is the app's own: sidecars take whatever ephemeral port they are handed next.
 *
 * `siblings` is every other directory that could claim a socket — the workspace's other repos, and a monorepo's
 * app instances. The most specific one wins, exactly as listenersByRepo decides it for the panels list, so a
 * repo cloned inside another (and an app inside its monorepo) keeps its own servers instead of being counted
 * twice. */
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

/* The rule, in order: the assigned port when something is on it (a dev server that honors PORT is the ordinary
 * case, and it is checked against the RAW listener list because a socket whose cwd procfs would not give up is
 * still that server); else the single port this directory is serving, whoever started it; else the ambiguity,
 * named; else starting-vs-stopped, which the assignment answers. */
export interface PanelSockets {
    // Where this panel's own processes run: `<repo>`, or `<repo>/_apps/<app>` for one app instance.
    readonly dir: string | undefined;
    // Every other directory that could claim a socket (the workspace's other repos), so the most specific one
    // wins and a repo cloned inside another keeps its servers.
    readonly siblings: readonly string[];
    readonly listeners: readonly ListeningPort[];
    readonly assignedPort: number | undefined;
    // Whether the assigned port ANSWERS, for a caller that knows better than the scan: the panels list dials
    // it, which catches the server whose cwd procfs would not give up (the scan can then attribute nothing).
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

/* The live resolver the preview proxy holds. Every request to a preview hostname asks it, so the port scan (a
 * procfs walk over every process's fd table) is cached for a beat and shared by whoever asks during it: a page
 * load is dozens of requests and must not be dozens of walks. The window is short enough that a dev server
 * that just bound its port is previewable a moment later, rather than after a poll. */
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
        // Coalescing is by IN-FLIGHT read, not by the window: a page load fires its requests within the same
        // tick, so with a short window (or none) they would each start their own procfs walk and the cache
        // would never once be hit. Whoever asks while a walk is running gets that walk's answer.
        if (reading !== undefined) {
            return reading;
        }
        const walk = Promise.all([deps.repos(), deps.listeners()]).then(([repos, listeners]) => {
            const snapshot: Snapshot = { repos, listeners };
            // Only a scan that SUCCEEDED is worth a window: a failed one leaves nothing cached, so the next
            // request re-reads instead of serving the error for the rest of it.
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
            // The scan is the enrichment, not the answer: with it unavailable the assignment still says whether
            // the daemon is running this panel at all.
            return assigned === undefined ? { state: "stopped" } : { state: "serving", port: assigned, assigned: true };
        }
    };
};
