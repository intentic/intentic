import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../../path-exists.js";
import { IGNORED_DIRS, REFERENCE_DIR } from "@intentic/workspace-ignore";
import { isManifest, managerFromPackageJson, recipeFor, type SetupRecipe } from "@intentic/workspace-setup";
import { onPath } from "../../platform/boot/on-path.js";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { unresolvedDependencies, unresolvedSummary, type UnresolvedPackage } from "../deps/dependency-drift.js";

// Workspace readiness: whether a project's dependencies are actually installed, and the one-shot install that fixes it.
// A dropped project arrives without node_modules (wrong platform, slow to upload); present files aren't a working
// workspace.
// Read by the import UI, the post-edit type-check, a failed pnpm test's explanation, and the agent's own tools.

// Bounds the scan like repo-discovery, shallower: a manifest this deep belongs to its own workspace member.
const MAX_DEPTH = 3;
const MAX_DIRS = 5_000;

export interface WorkspaceProject {
    // Root-relative POSIX dir; "" is the workspace root itself.
    readonly dir: string;
    readonly recipe: SetupRecipe;
}

// One of:
// - ready: marker present (node also walks declared deps; python is marker-only)
// - installing: this project's install panel is running
// - needs-setup: no marker, manager available
// - unsupported: no marker, manager not in this sandbox (UI names it via `manager`)
// - stale: marker present but the tree behind it is behind (dependency-drift.ts)
export type SetupState = "ready" | "installing" | "needs-setup" | "unsupported" | "stale";

// States an install would change; named once so the install route, import flow, and reconciler agree.
export const INSTALLABLE: ReadonlySet<SetupState> = new Set<SetupState>(["needs-setup", "stale"]);

export interface ProjectSetupStatus extends WorkspaceProject {
    readonly state: SetupState;
    // What failed to resolve, present only when stale; carried rather than recomputed by each reader.
    readonly unresolved?: readonly UnresolvedPackage[];
}

// Collapses a dir path to a tmux-safe key; `--install` can't collide with an app's `--<app>` panel key.
export const installPanelKey = (dir: string): string => `${dir === "" ? "root" : dir.replace(/[^a-zA-Z0-9_-]/g, "_")}--install`;

// Reads the packageManager field from this dir's package.json; unreadable or malformed falls back to the lockfile.
const packageManagerField = async (dir: string, names: readonly string[]): Promise<string | undefined> => {
    if (!names.includes("package.json")) {
        return undefined;
    }
    const text = await readFile(join(dir, "package.json"), "utf8").catch(() => undefined);
    return text === undefined ? undefined : managerFromPackageJson(text);
};

// Every project under root; the walk stops at the first manifest on a branch, so a monorepo counts as one project.
// Hidden dirs, junk dirs, and the reference shelf are never descended, same pruning as the tree walk.
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

// Checks `installing` first: a running install has often already created an empty marker.
// Runs on the main tree but is read from a worktree; sound only because the marker is mirrored into every isolated
// turn.
export const setupStateOf = async (
    root: string,
    project: WorkspaceProject,
    processes: ManagedProcesses,
    available: (binary: string) => Promise<boolean> = onPath,
): Promise<Pick<ProjectSetupStatus, "state" | "unresolved">> => {
    if (processes.running(installPanelKey(project.dir))) {
        return { state: "installing" };
    }
    if (await pathExists(join(root, project.dir, project.recipe.marker))) {
        if (project.recipe.ecosystem !== "node") {
            return { state: "ready" };
        }
        const unresolved = await unresolvedDependencies(join(root, project.dir));
        return unresolved.length === 0 ? { state: "ready" } : { state: "stale", unresolved };
    }
    return { state: (await available(project.recipe.manager)) ? "needs-setup" : "unsupported" };
};

export const workspaceSetup = async (root: string, processes: ManagedProcesses): Promise<ProjectSetupStatus[]> => {
    const projects = await discoverProjects(root);
    return Promise.all(
        projects.map(async (project) => Object.assign({ dir: project.dir, recipe: project.recipe }, await setupStateOf(root, project, processes))),
    );
};

// How many names one project contributes, bounded like the wire count: a mid-migration project can be missing hundreds.
export const missingCount = (status: ProjectSetupStatus): number => (status.unresolved ?? []).reduce((total, entry) => total + entry.names.length, 0);

// Starts the install as a one-shot panel process (attachable tmux): survives a reload, output stays in history.
// `start` no-ops while the session lives, so a re-drop mid-install can't spawn a second one.
export const startInstall = async (root: string, project: WorkspaceProject, processes: ManagedProcesses): Promise<void> => {
    await processes.start(installPanelKey(project.dir), {
        command: project.recipe.command,
        cwd: join(root, project.dir),
        oneShot: true,
    });
};

// The one paragraph a turn is told when /work isn't installed; native runtimes have no other seam for it.
// A stale project is never told to install; the daemon reconciles it, since an in-turn install rewrites other turns'
// mounted tree.
// Says NEXT turn, not "once idle": the reconciler defers while any turn is live, so idle depends on the turn reading
// it.

// Fixed opening stripTurnPreamble anchors on to recognize an injected note in a stored message.
export const SETUP_NOTICE_HEADER =
    "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet";

// Its own opening: without one, a stale-only notice isn't recognized and re-appends on every restore.
export const STALE_NOTICE_HEADER = "Some dependencies declared under /work are not installed";

// Titles beside each header (turn-preamble.ts pairs them); picked from the built notice's own opening.
export const SETUP_NOTICE_TITLE = "Dependencies aren't installed yet";
export const STALE_NOTICE_TITLE = "Dependencies are behind";
export const setupNoticeTitle = (notice: string): string => (notice.startsWith(SETUP_NOTICE_HEADER) ? SETUP_NOTICE_TITLE : STALE_NOTICE_TITLE);

// A project's dir names it; the root's own manifest is "the workspace root", not an empty string.
const where = (status: ProjectSetupStatus): string => (status.dir === "" ? "the workspace root" : status.dir);

export const setupNoticeFor = (statuses: readonly ProjectSetupStatus[]): string | undefined => {
    const pending = statuses.filter((status) => status.state === "needs-setup" || status.state === "unsupported");
    const stale = statuses.filter((status) => status.state === "stale");
    if (pending.length === 0 && stale.length === 0) {
        return undefined;
    }
    const lines = pending.map((status) =>
        status.state === "unsupported"
            ? `- ${where(status)}: needs \`${status.recipe.manager}\`, which is not installed in this sandbox. Do not attempt the install; say so if it blocks the task.`
            : `- ${where(status)}: has never been set up and needs \`${status.recipe.command}\`. Do not run it inside this turn; ask the owner to install it.`,
    );
    const staleLines = stale.map(
        (status) =>
            `- ${where(status)}: ${missingCount(status)} declared dependencies are not installed (${unresolvedSummary(status.unresolved ?? [])}).`,
    );
    return [
        ...(lines.length === 0 ? [] : [SETUP_NOTICE_HEADER, "(a dropped project arrives without them on purpose):", ...lines]),
        ...(staleLines.length === 0
            ? []
            : [
                  `${STALE_NOTICE_HEADER}, so an unresolved import there is the install being behind rather than a mistake ` +
                      "in the code. Do not edit working source to satisfy one, and do not run an install: from inside a turn " +
                      "it writes to a scratch layer that is discarded, and it rewrites the dependency tree other live " +
                      "conversations are reading. The daemon installs it once the turn ends, so the tree is ready on the NEXT " +
                      "turn, not this one. Nothing else is blocked: every already-installed project type-checks and tests " +
                      "normally. If this one's own checks are what the task needs, finish the rest, say the verification is " +
                      "deferred, and offer to re-run it next turn:",
                  ...staleLines,
              ]),
    ].join("\n");
};
