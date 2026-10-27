import { refuse } from "@intentic/contract-serve";
import type { PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { STATE_DIR } from "@intentic/constants";
import { fileBody, REPOS, workspaceEntries } from "../../fixture/workspace";
import { monorepoFiles } from "./monorepo";
import { exists, noteWritten } from "./edits";
import { pushRepos, pushRuntime } from "./workspaceBroadcast";

// The repositories a visitor brings in: cloned from an address, or started from nothing. They sit beside the
// recording's own (`web`, `api`), are listed wherever the daemon lists repos, and their files are ordinary rows of the
// tree, so everything that reads the tree (search, tests, the dependency graph) sees them at once.

type CloneResult = SandboxHandlerOutput<`workspace`, `addRepo`>;

const ADDED = new Map<string, { readonly from?: string }>();

/** Every repository's id, sorted, as GET /workspace/repos and the `reposChanged` push carry them. */
export const workspaceRepos = (): string[] => [...REPOS, ...ADDED.keys()].toSorted();

// The daemon's own rule (isValidRepoName): a plain folder name, none of the sandbox's own folders.
const RESERVED = new Set([`root`, `public`, `refs`, `node_modules`, STATE_DIR, `.git`]);
const validName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) && !RESERVED.has(name);

const checkFree = (name: string): void => {
    if (!validName(name)) {
        refuse(`invalid or reserved repo name`, 400);
    }
    if (exists(name) || ADDED.has(name)) {
        refuse(`"${name}" already exists in the workspace`, 409);
    }
};

// A clone over the sandbox's network: long enough to watch the pane's progress, short enough not to bore.
const CLONE_MS = 2_400;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const land = (name: string, files: readonly [string, string][]): void => {
    const table = workspaceEntries();
    for (const [path, body] of files) {
        table.set(path, body);
    }
    noteWritten(files.map(([path]) => path));
    pushRepos(workspaceRepos());
    // The panel sweep's push: a new repo is a new row on the rail.
    pushRuntime(`panels`);
};

/** POST /workspace/repos: clones `cloneUrl` in as `name`; what lands is a pnpm workspace (monorepo.ts). */
export const cloneRepo = async (name: string, cloneUrl: string): Promise<CloneResult> => {
    checkFree(name);
    ADDED.set(name, { from: cloneUrl });
    // Claimed before the wait (ADDED), as the daemon's clone holds the folder: a second press meanwhile is "already exists".
    await wait(CLONE_MS);
    land(name, monorepoFiles(name));
    return { name, path: name };
};

/** POST /workspace/repos/new: a folder, initialised, with a README that names it and one commit. */
export const createRepo = (name: string): CloneResult => {
    checkFree(name);
    ADDED.set(name, {});
    land(name, [[`${name}/README.md`, `# ${name}\n`]]);
    return { name, path: name };
};

const filesUnder = (repo: string): string[] => [...workspaceEntries().keys()].filter((path) => path.startsWith(`${repo}/`));

/** Whether `repo` is a multi-package workspace: a pnpm-workspace.yaml at its root, as the daemon decides. */
const isMonorepo = (repo: string): boolean => fileBody(`${repo}/pnpm-workspace.yaml`) !== undefined;

const hasTests = (repo: string): boolean => filesUnder(repo).some((path) => /\.test\.[jt]sx?$/u.test(path) || /\/vitest\.config\./u.test(path));

/** Panel rows for the repos added here, for `panels.list` to carry beside the recording's: a clone is a monorepo
 * with tests, so the rail offers its Apps and Dependencies views; a new repo has nothing to run yet. */
export const workspacePanels = (): PanelSummary[] =>
    [...ADDED.keys()].map((repo) => ({
        repo,
        hasPanel: false,
        running: false,
        installed: false,
        healthy: false,
        servers: [],
        deployConfig: false,
        desiredState: false,
        directoryUi: false,
        monorepo: isMonorepo(repo),
        tests: hasTests(repo),
        userStories: false,
        docs: false,
    }));

/** The per-repo routes' own check (monorepoOf): a repository the workspace holds, and a multi-package one. */
export const monorepoOf = (repo: string): string => {
    if (!workspaceRepos().includes(repo)) {
        refuse(`no repo "${repo}" in the workspace`, 404);
    }
    if (!isMonorepo(repo)) {
        refuse(`"${repo}" is not a multi-package repo`, 400);
    }
    return repo;
};
