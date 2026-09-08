import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ListeningPort } from "../ports/port-scan.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

// Per-repo operator panels: a repo exposes one when `operator/` or the repo root has a runnable `dev` script; discovery
// is pure. The daemon runs that dev server and the preview proxy fronts it at preview-<panelKey>-<sandboxId>.<zone>.

const OPERATOR_DIR = "operator";

export interface DiscoveredPanel {
    readonly repo: string;
    readonly hasPanel: boolean;
}

// DNS-label/tmux-safe key for a repo id: `/` becomes `--`, matching app previews' `<repo>--<app>` grammar. Undefined
// for a name with dots or underscores; such repos still list, just without a panel process.
export const panelKey = (id: string): string | undefined => {
    const key = id.replaceAll("/", "--");
    return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key) ? key : undefined;
};

// Does `dir/package.json` declare a `dev` script?
const hasDevScript = async (dir: string): Promise<boolean> => {
    try {
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
        return typeof pkg.scripts?.["dev"] === "string";
    } catch {
        return false;
    }
};

// Where the panel's dev server runs: `operator/` when it has a `dev` script, else the repo root when that does;
// undefined otherwise. `operator/` wins so a repo can carry a dedicated panel beside its code.
export const panelRunDir = async (workspace: WorkspacePaths, repo: string): Promise<string | undefined> => {
    const root = join(workspace.root, repo);
    const operator = join(root, OPERATOR_DIR);
    if (await hasDevScript(operator)) {
        return operator;
    }
    if (await hasDevScript(root)) {
        return root;
    }
    return undefined;
};

// Every repo in the workspace, sorted, each annotated with whether it exposes a runnable panel.
export const discoverPanels = async (workspace: WorkspacePaths): Promise<DiscoveredPanel[]> => {
    const repos = await discoverRepos(workspace.root);
    return Promise.all(repos.map(async (repo) => ({ repo, hasPanel: (await panelRunDir(workspace, repo)) !== undefined })));
};

// Maps each repo to the sockets its own directory serves, using listening sockets as evidence, not the assigned port. A
// socket with no readable cwd, outside the workspace, or not forwardable belongs to nobody.
export const listenersByRepo = (
    listeners: readonly ListeningPort[],
    workspaceRoot: string,
    repos: readonly string[],
): Map<string, readonly ListeningPort[]> => {
    // Longest dir first, so the first match is the most specific repo rather than whichever came back first.
    const dirs = repos.map((repo) => ({ repo, dir: join(workspaceRoot, repo) })).toSorted((a, b) => b.dir.length - a.dir.length);
    const byRepo = new Map<string, ListeningPort[]>();
    for (const listener of listeners) {
        const cwd = listener.cwd;
        if (!listener.forwardable || cwd === undefined) {
            continue;
        }
        const owner = dirs.find(({ dir }) => cwd === dir || cwd.startsWith(`${dir}/`));
        if (owner === undefined) {
            continue;
        }
        byRepo.set(owner.repo, [...(byRepo.get(owner.repo) ?? []), listener]);
    }
    return byRepo;
};

// Which package inside the repo bound a listener (e.g. `_editor/web`), the one thing telling several dev servers apart;
// undefined at the repo root or with no readable cwd.
export const listenerDir = (listener: ListeningPort, workspaceRoot: string, repo: string): string | undefined => {
    const root = join(workspaceRoot, repo);
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
