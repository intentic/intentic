import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRepos } from "../workspace/extra-repos.js";
import { REPO_ROLES, type WorkspacePaths } from "../workspace/workspace.js";

// Per-repository operator panels. Every git repo under /work/repositories is one sidebar entry; a repo exposes
// a panel by convention — a runnable dev server (a package.json with a `dev` script) at either its `operator/`
// dir (a purpose-built panel, e.g. the ported infra UI) OR the repo root (a scaffolded app IS its own panel).
// Discovery is pure (no manifest): the daemon runs that dev server, the preview proxy fronts it at
// preview-<repo>-<sandboxId>.<zone> (see preview-hostname.ts).

const OPERATOR_DIR = "operator";

export interface DiscoveredPanel {
    readonly repo: string;
    readonly hasPanel: boolean;
}

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
    const root = join(workspace.repositories, repo);
    const operator = join(root, OPERATOR_DIR);
    if (await hasDevScript(operator)) {
        return operator;
    }
    if (await hasDevScript(root)) {
        return root;
    }
    return undefined;
};

const exists = async (dir: string): Promise<boolean> => {
    try {
        await access(dir);
        return true;
    } catch {
        return false;
    }
};

// Every repo in the workspace: the three fixed roles that exist on disk, plus every extra clone, sorted and
// de-duplicated, each annotated with whether it exposes a runnable panel.
export const discoverPanels = async (workspace: WorkspacePaths): Promise<DiscoveredPanel[]> => {
    const roles = (await Promise.all(REPO_ROLES.map(async (role) => ((await exists(workspace.repos[role])) ? role : undefined)))).filter(
        (role): role is (typeof REPO_ROLES)[number] => role !== undefined,
    );
    const repos = [...new Set([...roles, ...(await listRepos(workspace.repositories))])].toSorted();
    return Promise.all(repos.map(async (repo) => ({ repo, hasPanel: (await panelRunDir(workspace, repo)) !== undefined })));
};
