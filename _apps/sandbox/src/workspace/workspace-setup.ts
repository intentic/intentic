import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS, REFERENCE_DIR } from "@intentic/workspace-ignore";
import { isManifest, managerFromPackageJson, recipeFor, type SetupRecipe } from "@intentic/workspace-setup";
import type { ManagedProcesses } from "../processes/managed-processes.js";

// Workspace READINESS: whether the projects under /work actually have their dependencies installed, and the
// one-shot install that gets them there. A drag-dropped project arrives without node_modules on purpose (the
// drop omits it — it would be slow to upload and wrong to reuse, having been built against the laptop's
// libc), so "the files are here" and "this workspace works" are different states. Everything that would
// otherwise mislead reads this: the import UI offers the install, the agent's post-edit type-check stays
// silent rather than reporting every import as broken (agent-diagnostics.ts), and the agent's turn is told
// once, plainly, instead of rediscovering it through a failed `pnpm test`.

// Bound the scan the same way repo-discovery does: a project deeper than this isn't found, and a pathological
// tree stops rather than stalling the daemon. Shallower than repo discovery's 4 — a manifest that deep is a
// workspace member, and members install from their root.
const MAX_DEPTH = 3;
const MAX_DIRS = 5_000;

export interface WorkspaceProject {
    // Root-relative POSIX dir; "" is the workspace root itself owning the manifest.
    readonly dir: string;
    readonly recipe: SetupRecipe;
}

// ready       — the marker (node_modules/.venv) is on disk; tooling can be trusted.
// installing  — this project's install panel is running right now.
// needs-setup — no marker, and the manager is available to fix it.
// unsupported — no marker and the manager isn't in this sandbox, so offering an install would just fail in a
//               terminal. The UI names the missing binary instead (it rides `manager`).
export type SetupState = "ready" | "installing" | "needs-setup" | "unsupported";

export interface ProjectSetupStatus extends WorkspaceProject {
    readonly state: SetupState;
}

// tmux session names carry `panel-<key>`, so a key must survive as one: a nested dir's separator and any
// punctuation collapse to `_`. The `--install` suffix matches the `--add_apps` convention — an underscore
// inside the suffix means it can never collide with an app panel key (`<repo>--<app>`, app being a slug).
export const installPanelKey = (dir: string): string => `${dir === "" ? "root" : dir.replace(/[^a-zA-Z0-9_-]/g, "_")}--install`;

// Is `binary` executable on PATH? Read straight off the filesystem rather than spawning `command -v`: no shell
// (the manager name reaches us from an uploaded package.json), no per-call process. Cached for the daemon's
// life — PATH is fixed at container start, and a capability rebuild restarts the daemon.
const pathCache = new Map<string, Promise<boolean>>();
const onPath = (binary: string): Promise<boolean> => {
    const cached = pathCache.get(binary);
    if (cached !== undefined) {
        return cached;
    }
    const probe = (async (): Promise<boolean> => {
        for (const dir of (process.env["PATH"] ?? "").split(":")) {
            if (dir === "") {
                continue;
            }
            try {
                await access(join(dir, binary), constants.X_OK);
                return true;
            } catch {
                // next PATH entry
            }
        }
        return false;
    })();
    pathCache.set(binary, probe);
    return probe;
};

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// The `packageManager` declaration, when this dir has a package.json to read it from. An unreadable or
// malformed manifest yields undefined and detection falls back to the lockfile — never an error, since this
// runs over whatever a user dropped.
const packageManagerField = async (dir: string, names: readonly string[]): Promise<string | undefined> => {
    if (!names.includes("package.json")) {
        return undefined;
    }
    const text = await readFile(join(dir, "package.json"), "utf8").catch(() => undefined);
    return text === undefined ? undefined : managerFromPackageJson(text);
};

// Every project under `root`. The walk STOPS at the first manifest on a branch: a monorepo installs once from
// its root, so descending into its members would report N projects that are really one. Hidden dirs, the
// junk denylist (node_modules, dist, …) and the reference shelf are never descended into — same pruning as the
// tree walk (a cloned reference repo is consulted, not installed, so its missing node_modules must not nag).
export const discoverProjects = async (root: string): Promise<WorkspaceProject[]> => {
    const projects: WorkspaceProject[] = [];
    let visited = 0;
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || visited >= MAX_DIRS) {
            return;
        }
        visited += 1;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const names = entries.map((entry) => entry.name);
        if (names.some(isManifest)) {
            const recipe = recipeFor(names, await packageManagerField(dir, names));
            if (recipe !== undefined) {
                projects.push({ dir: rel, recipe });
                return;
            }
        }
        await Promise.all(
            entries
                .filter(
                    (entry) =>
                        entry.isDirectory() &&
                        !entry.name.startsWith(".") &&
                        !IGNORED_DIRS.has(entry.name) &&
                        !(rel === "" && entry.name === REFERENCE_DIR),
                )
                .map((entry) => walk(join(dir, entry.name), rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1)),
        );
    };
    await walk(root, "", 1);
    return projects.toSorted((left, right) => left.dir.localeCompare(right.dir));
};

// One project's state. `installing` is checked FIRST: a running install has usually already created an empty
// node_modules, so a marker-first order would flip the panel to "ready" seconds after it started. `available`
// is injected by tests so a case can assert on a manager this machine happens to have (or lack).
export const setupStateOf = async (
    root: string,
    project: WorkspaceProject,
    processes: ManagedProcesses,
    available: (binary: string) => Promise<boolean> = onPath,
): Promise<SetupState> => {
    if (processes.running(installPanelKey(project.dir))) {
        return "installing";
    }
    if (await exists(join(root, project.dir, project.recipe.marker))) {
        return "ready";
    }
    return (await available(project.recipe.manager)) ? "needs-setup" : "unsupported";
};

export const workspaceSetup = async (root: string, processes: ManagedProcesses): Promise<ProjectSetupStatus[]> => {
    const projects = await discoverProjects(root);
    return Promise.all(
        projects.map(async (project) => ({ dir: project.dir, recipe: project.recipe, state: await setupStateOf(root, project, processes) })),
    );
};

// Start one project's install as a one-shot panel process — the same mechanism as a dev server or `add-app`,
// deliberately: it runs in an attachable tmux session, so a minutes-long install survives a page reload, the
// owner can watch it, Ctrl+C it, and `↑` re-run it, and its output stays in the terminal history logs for a
// post-mortem. `start` no-ops while the session lives, so a re-drop mid-install can't spawn a second one.
export const startInstall = async (root: string, project: WorkspaceProject, processes: ManagedProcesses): Promise<void> => {
    await processes.start(installPanelKey(project.dir), {
        command: project.recipe.command,
        cwd: join(root, project.dir),
        oneShot: true,
    });
};

// The single line an agent turn is told when something under /work isn't installed. Naming the exact command
// per project is what stops the model rediscovering it the expensive way — through a `not found` from a
// package script, an `npx` that hits the registry for a binary that was never a package, and a file of
// type-check errors that are all false.

// The notice's fixed opening — what stripTurnPreamble anchors on to recognize an injected note in a stored
// user message (turn-preamble.ts).
export const SETUP_NOTICE_HEADER =
    "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet";

export const setupNoticeFor = (statuses: readonly ProjectSetupStatus[]): string | undefined => {
    const pending = statuses.filter((status) => status.state === "needs-setup" || status.state === "unsupported");
    if (pending.length === 0) {
        return undefined;
    }
    const lines = pending.map((status) => {
        const where = status.dir === "" ? "the workspace root" : status.dir;
        return status.state === "unsupported"
            ? `- ${where}: needs \`${status.recipe.manager}\`, which is not installed in this sandbox. Do not attempt the install; say so if it blocks the task.`
            : `- ${where}: run \`${status.recipe.command}\` there first.`;
    });
    return [SETUP_NOTICE_HEADER, "(a dropped project arrives without them on purpose):", ...lines].join("\n");
};
