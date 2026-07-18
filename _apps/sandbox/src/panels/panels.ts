import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";

// Per-repository operator panels. Every discovered git repo under /work is one sidebar entry; a repo exposes
// a panel by convention — a runnable dev server (a package.json with a `dev` script) at either its `operator/`
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
// (dots/underscores) — such repos list and review fine, they just expose no preview/panel process.
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
