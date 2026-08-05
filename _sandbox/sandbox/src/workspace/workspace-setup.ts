import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS, REFERENCE_DIR } from "@intentic/workspace-ignore";
import { isManifest, managerFromPackageJson, recipeFor, type SetupRecipe } from "@intentic/workspace-setup";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { unresolvedDependencies, unresolvedSummary, type UnresolvedPackage } from "./dependency-drift.js";

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

// ready       — the marker (node_modules/.venv) is on disk AND satisfies the manifests; tooling can be trusted.
// installing  — this project's install panel is running right now.
// needs-setup — no marker, and the manager is available to fix it.
// unsupported — no marker and the manager isn't in this sandbox, so offering an install would just fail in a
//               terminal. The UI names the missing binary instead (it rides `manager`).
// stale       — the marker is there and the tree behind it is out of date: something declares a dependency that
//               is not installed (dependency-drift.ts). A DISTINCT state rather than folding into needs-setup,
//               because the two read completely differently to whoever sees them — "this project has never been
//               set up" is a property of a fresh import, "your last change hasn't been installed yet" is an
//               event that just happened — even though the same command resolves both.
export type SetupState = "ready" | "installing" | "needs-setup" | "unsupported" | "stale";

// The states an install would actually change something about. Named once, because three surfaces decide it and
// they must not drift apart: the install route, the import flow behind it, and the post-land reconciler.
// `installing` is excluded on purpose — a second install of a running one is what `processes.start` no-ops, and
// asking for it is still a bug in the caller.
export const INSTALLABLE: ReadonlySet<SetupState> = new Set<SetupState>(["needs-setup", "stale"]);

export interface ProjectSetupStatus extends WorkspaceProject {
    readonly state: SetupState;
    // What could not resolve, present only on `stale`. Carried rather than recomputed by every reader: the walk
    // costs a stat per declared dependency, and the notice, the wire shape and the auto-install decision all
    // need the same answer within milliseconds of each other.
    readonly unresolved?: readonly UnresolvedPackage[];
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

/* One project's state, and what is missing when it is `stale`. `installing` is checked FIRST: a running install
 * has usually already created an empty node_modules, so a marker-first order would flip the panel to "ready"
 * seconds after it started. `available` is injected by tests so a case can assert on a manager this machine
 * happens to have (or lack).
 *
 * The drift walk runs only AFTER the marker is found, and only for node: it is the one ecosystem whose declared
 * dependencies can be read off a manifest and looked for by name. A python project with a .venv is reported
 * `ready` on the marker alone, exactly as before — claiming to have measured it would be the same conflation
 * the chores probes refuse (unmeasured is not clean).
 */
export const setupStateOf = async (
    root: string,
    project: WorkspaceProject,
    processes: ManagedProcesses,
    available: (binary: string) => Promise<boolean> = onPath,
): Promise<Pick<ProjectSetupStatus, "state" | "unresolved">> => {
    if (processes.running(installPanelKey(project.dir))) {
        return { state: "installing" };
    }
    if (await exists(join(root, project.dir, project.recipe.marker))) {
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

// How many names one project contributes to the notice, and how many the wire carries. Both bounded for the
// same reason: a project mid-migration can be missing hundreds, and neither the model nor the panel is helped
// by the tail.
export const missingCount = (status: ProjectSetupStatus): number => (status.unresolved ?? []).reduce((total, entry) => total + entry.names.length, 0);

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

/* The single line an agent turn is told when something under /work isn't installed. Naming the exact command
 * per project is what stops the model rediscovering it the expensive way — through a `not found` from a
 * package script, an `npx` that hits the registry for a binary that was never a package, and a file of
 * type-check errors that are all false.
 *
 * A STALE project is told about differently, and the difference is the point. It is not asked to install
 * anything: the daemon reconciles a stale tree by itself (agent.routes.ts), and an install inside an isolated
 * turn would write into an overlay that dies with the conversation anyway. What the turn is given is the one
 * fact it cannot deduce and will otherwise be misled by — that an import failing to resolve right now is the
 * install being behind, not the code being wrong. Without it the model reads a wall of true-looking errors and
 * starts editing correct source to satisfy them.
 *
 * WHEN the repair arrives is stated as NEXT TURN, and that precision is the whole of what this paragraph got
 * wrong for a long time. It used to promise the workspace "reconciles itself once it is idle" — true, and
 * unactionable from where it is read: the reconciler defers while any turn is live (reconcile-deps.ts), and the
 * agent reading the sentence IS a live turn. So the relief it promised could not arrive until the reader
 * stopped, and nothing ever signalled that it had. A model told to wait, given no end to the wait, concludes it
 * cannot verify anything at all — and then reports work as done on reasoning alone, which is the failure this
 * notice exists to prevent, arrived at from the other side. Saying "next turn" converts a dead end into a
 * handoff, and the sentence after it says the part the model otherwise infers wrongly: only THIS project's own
 * checks are deferred, and the rest of the workspace tests normally.
 *
 * The install is also refused with its REASON attached rather than as bare instruction. The reason is not the
 * agent's own wasted minutes — it is that a turn's install rewrites the dependency tree every other live
 * conversation has mounted beneath it (agents/isolation.ts). A rule whose cost falls on somebody else has to
 * say so, or the first model that decides it knows better is right to.
 */

// The notice's fixed opening — what stripTurnPreamble anchors on to recognize an injected note in a stored
// user message (turn-preamble.ts).
export const SETUP_NOTICE_HEADER =
    "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet";

/* The STALE half's own opening, and it needs one of its own for a reason that took a while to show itself.
 *
 * The two halves are independent: a workspace whose projects are all installed-but-behind emits a notice that
 * never carries the header above, and the stripper anchors on a known opening or does nothing. So on this
 * workspace — which produces exactly that shape — the preamble was never recognized, and every stored message
 * came back out of restore with the whole paragraph stapled to the front of it as the user's own words. The
 * chat then showed a "hello" as three sentences about node_modules. Being a prefix rather than a line of its
 * own is what keeps the notice reading as prose while still giving the stripper something to anchor on. */
export const STALE_NOTICE_HEADER = "Some dependencies declared under /work are not installed";

// A project names itself by its directory; the root owns the manifest under a name rather than an empty string.
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
            : `- ${where(status)}: run \`${status.recipe.command}\` there first.`,
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
                      "in the code. Do not edit working source to satisfy one, and do not run an install — from inside a turn " +
                      "it writes to a scratch layer that is discarded, and it rewrites the dependency tree other live " +
                      "conversations are reading. The daemon installs it once the turn ends, so the tree is ready on the NEXT " +
                      "turn, not this one. Nothing else is blocked: every already-installed project type-checks and tests " +
                      "normally. If this one's own checks are what the task needs, finish the rest, say the verification is " +
                      "deferred, and offer to re-run it next turn:",
                  ...staleLines,
              ]),
    ].join("\n");
};
