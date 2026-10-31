import { join } from "node:path";
import type { ProgramWindow } from "../desktop/program-windows.js";
import type { ListeningPort } from "../ports/port-scan.js";
import { discoverRepos, ROOT_REPO, repoDirOf } from "../workspace/layout/repo-discovery.js";
import { sandboxTargetsAt } from "../workspace/layout/run-file.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { type RunPlan, runPlanOf } from "./run-plan.js";

// Per-repo operator panels: a repo exposes one when run-plan.ts can tell what Start runs for it (a Procfile, an
// `operator/` or root `dev` script, a root `start`, a Cargo binary); discovery is pure. The daemon runs that command and
// the preview proxy fronts what it serves at preview-<panelKey>-<sandboxId>.<zone>.

export interface DiscoveredPanel {
    readonly repo: string;
    // What Start runs; undefined for a repo with nothing it can tell how to start.
    readonly plan: RunPlan | undefined;
}

// DNS-label/tmux-safe key for a repo id: `/` becomes `--`, matching app previews' `<repo>--<app>` grammar. Undefined
// for a name with dots or underscores; such repos still list, just without a panel process.
export const panelKey = (id: string): string | undefined => {
    const key = id.replaceAll("/", "--");
    return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key) ? key : undefined;
};

// Every repo in the workspace, sorted, each with what Start would run for it. The workspace's own repository (ROOT_REPO)
// leads the list only when it has something to run, a project kept at the workspace root: a Procfile or the like, or a
// target its .intentic/run.json runs in the sandbox. Every other workspace root is a folder of repositories, nothing to
// offer a Start for.
export const discoverPanels = async (workspace: WorkspacePaths): Promise<DiscoveredPanel[]> => {
    const repos = await discoverRepos(workspace.root);
    const [rootPlan, ...plans] = await Promise.all([workspace.root, ...repos.map((repo) => join(workspace.root, repo))].map(runPlanOf));
    const found = repos.map((repo, index) => ({ repo, plan: plans[index] }));
    return rootPlan !== undefined || sandboxTargetsAt(workspace.root).length > 0 ? [{ repo: ROOT_REPO, plan: rootPlan }, ...found] : found;
};

// The repo a directory belongs to: the most specific one holding it, so a repo nested in another claims its own files.
// Undefined outside every repo.
const repoOfDir = (workspaceRoot: string, repos: readonly string[]): ((cwd: string) => string | undefined) => {
    // Longest dir first, so the first match is the most specific repo rather than whichever came back first.
    const dirs = repos.map((repo) => ({ repo, dir: repoDirOf(workspaceRoot, repo) })).toSorted((a, b) => b.dir.length - a.dir.length);
    return (cwd) => dirs.find(({ dir }) => cwd === dir || cwd.startsWith(`${dir}/`))?.repo;
};

// Maps each repo to the sockets its own directory serves, using listening sockets as evidence, not the assigned port. A
// socket with no readable cwd, outside the workspace, or not forwardable belongs to nobody.
export const listenersByRepo = (
    listeners: readonly ListeningPort[],
    workspaceRoot: string,
    repos: readonly string[],
): Map<string, readonly ListeningPort[]> => {
    const ownerOf = repoOfDir(workspaceRoot, repos);
    const byRepo = new Map<string, ListeningPort[]>();
    for (const listener of listeners) {
        const owner = listener.forwardable && listener.cwd !== undefined ? ownerOf(listener.cwd) : undefined;
        if (owner !== undefined) {
            byRepo.set(owner, [...(byRepo.get(owner) ?? []), listener]);
        }
    }
    return byRepo;
};

// Maps each repo to the windows its programs opened on the sandbox desktop, by the same evidence as its sockets: the
// directory the program that owns the window runs in. A window whose program says nothing of where it runs belongs to
// nobody.
export const windowsByRepo = (
    windows: readonly ProgramWindow[],
    workspaceRoot: string,
    repos: readonly string[],
): Map<string, readonly ProgramWindow[]> => {
    const ownerOf = repoOfDir(workspaceRoot, repos);
    const byRepo = new Map<string, ProgramWindow[]>();
    for (const window of windows) {
        const owner = window.cwd === undefined ? undefined : ownerOf(window.cwd);
        if (owner !== undefined) {
            byRepo.set(owner, [...(byRepo.get(owner) ?? []), window]);
        }
    }
    return byRepo;
};

// Which package inside the repo bound a listener (e.g. `_editor/web`), the one thing telling several dev servers apart;
// undefined at the repo root or with no readable cwd.
export const listenerDir = (listener: ListeningPort, workspaceRoot: string, repo: string): string | undefined => {
    const root = repoDirOf(workspaceRoot, repo);
    return listener.cwd === undefined || listener.cwd === root ? undefined : listener.cwd.slice(root.length + 1);
};

// One server per package: a dev server binds more than one socket (Vite's HMR channel, its optimizer). Lowest port in a
// directory is the app's own; sidecars take whatever comes next, and `servers` must arrive sorted by port already.
export const oneServerPerDir = <T extends { dir?: string | undefined }>(servers: readonly T[]): T[] => {
    const byDir = new Map<string, T>();
    for (const server of servers) {
        const dir = server.dir ?? ``;
        if (!byDir.has(dir)) {
            byDir.set(dir, server);
        }
    }
    return [...byDir.values()];
};
