import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ListeningPort } from "../ports/port-scan.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

// Per-repository operator panels. Every discovered git repo under /work is one sidebar entry; a repo exposes
// a panel by convention, a runnable dev server (a package.json with a `dev` script) at either its `operator/`
// dir (a purpose-built panel, e.g. the ported infra UI) OR the repo root (a scaffolded app IS its own panel).
// Discovery is pure (no manifest): the daemon runs that dev server, the preview proxy fronts it at
// preview-<panelKey>-<sandboxId>.<zone> (see sandbox-contract's hostnames.ts).

const OPERATOR_DIR = "operator";

export interface DiscoveredPanel {
    readonly repo: string;
    readonly hasPanel: boolean;
}

// A repo id as the DNS-label/tmux-safe key the preview hostname and the process manager use: slashes in
// nested ids become `--` (the same separator as app previews' `<repo>--<app>`, whose repo names forbid `--`
// so the grammars can't collide). undefined when the id carries characters a one-label subdomain can't
// (dots/underscores), such repos list and review fine, they just expose no preview/panel process.
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

// Where a repo's panel dev server runs, or undefined when the repo exposes no panel: `operator/` when it's a
// runnable app (infra + purpose-built panels), else the repo root when the repo itself is runnable (a scaffolded
// app previews as its own dev server). Preferring operator/ lets a repo carry a dedicated panel beside its code.
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

/* WHAT A REPO IS ACTUALLY SERVING, as opposed to what the daemon told it to serve.
 *
 * The panel manager assigns a free port, injects it as PORT, and used to health-check exactly that port. That
 * holds for a scaffolded app, whose dev server reads PORT, and is fiction for a repo whose `dev` script fans a
 * turbo run out across several packages that each pin their own port for reasons the daemon can't know (a
 * committed dev cert's origin, a CORS allowlist, an OAuth client's authorized redirect). Such a repo bound three
 * real ports, the daemon probed a fourth that nothing was listening on, and its panel reported "starting" for as
 * long as it ran.
 *
 * So the listening sockets are the evidence, and a repo's own directory is what claims them: a dev server's
 * process sits in the package it serves. The longest matching repo dir wins, so a repo cloned inside another
 * keeps its own listeners; a socket with no readable cwd, or a cwd outside the workspace, belongs to nobody.
 * Not-forwardable binds (a loopback alias that only answers at its own address) are dropped, nothing in the
 * sandbox could point a browser at them. */
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

// Which package inside the repo bound a listener, `_editor/web` for the app, `_site/site` for the marketing site.
// The one thing that tells a monorepo's three dev servers apart at a glance, so it rides to the browser beside
// the URL. Undefined when the process sits at the repo root (it IS the repo's server) or has no readable cwd.
export const listenerDir = (listener: ListeningPort, workspaceRoot: string, repo: string): string | undefined => {
    const root = join(workspaceRoot, repo);
    return listener.cwd === undefined || listener.cwd === root ? undefined : listener.cwd.slice(root.length + 1);
};

/* ONE SERVER PER PACKAGE, because a dev server is not one socket. Vite's HMR channel and its dependency
 * optimizer bind ports of their own from the very same directory, and a framework that embeds another app's dev
 * server adds more still, the intentic repo running two apps answers on five ports. Listing all five turns a
 * question with three answers into a menu of five, three-fifths of which are plumbing nobody can walk a user
 * story through.
 *
 * The lowest port in a directory is the app's: it is the one the package pinned or was assigned, while the
 * sidecars take whatever ephemeral port they are handed next. Expects `servers` already ordered by port, and a
 * package genuinely serving two things keeps the free-text field as its way out. */
export const oneServerPerDir = <T extends { dir?: string }>(servers: readonly T[]): T[] => {
    const byDir = new Map<string, T>();
    for (const server of servers) {
        const dir = server.dir ?? ``;
        if (!byDir.has(dir)) {
            byDir.set(dir, server);
        }
    }
    return [...byDir.values()];
};
