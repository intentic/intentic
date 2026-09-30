import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { sleep } from "@intentic/base/async";
import { isManifest } from "@intentic/workspace-setup";
import type { Logger } from "pino";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { unresolvedDependencies } from "./dependency-drift.js";
import { type DependencyOrigin, type DependencyRequestOrigin, originPriority } from "./dependency-origin.js";
import { behindCount, INSTALLABLE, installPanelKey, type ProjectSetupStatus, startInstall, workspaceSetup } from "../layout/workspace-setup.js";

const execFileAsync = promisify(execFile);

// One coordinator owns dependency maintenance: every drift or setup path feeds it, none starts a package manager
// itself. It waits for manifest writes to settle, then starts each install panel once, beside the agents rather than
// blocking a turn. Drift's in-memory origin outlives a later watcher event, so credit doesn't shift.

const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_INSTALL_MAX_MS = 30 * 60_000;

const RequestOriginSchema = z.object({
    kind: z.literal("request"),
    conversationId: z.string().optional(),
    title: z.string().optional(),
});
const RequestStateSchema = z.object({ projects: z.record(z.string(), RequestOriginSchema) });
interface RequestState {
    readonly projects: Record<string, DependencyRequestOrigin>;
}

export const dependencyRequestsDocument = defineDocument({ root: "history", path: "dependency-requests.json", schema: RequestStateSchema });

// The schema's value as this store holds it: each origin spelled for exact optional types.
const requestState = (parsed: z.output<typeof RequestStateSchema>): RequestState => ({
        projects: Object.fromEntries(
            Object.entries(parsed.projects).map(([dir, origin]) => [
                dir,
                {
                    kind: "request" as const,
                    ...(origin.conversationId === undefined ? {} : { conversationId: origin.conversationId }),
                    ...(origin.title === undefined ? {} : { title: origin.title }),
                },
            ]),
        ),
    });

export interface ReconcileOutcome {
    readonly missing: number;
    readonly started: string[];
    readonly deferred: boolean;
}

export interface DependencyIssue {
    readonly dir: string;
    readonly state: "stale" | "needs-setup";
    readonly names: readonly string[];
}

export interface DependencyInstallStarted {
    readonly dir: string;
    readonly origin: DependencyOrigin;
}

export interface DependencyInstallStartFailed {
    readonly dir: string;
    readonly origin: DependencyOrigin;
}

export interface DependencyRequestResult {
    readonly projects: readonly ProjectSetupStatus[];
    readonly queued: readonly string[];
}

export interface DependencyCoordinator {
    readonly status: () => Promise<ProjectSetupStatus[]>;
    readonly issueAt: (dir: string) => Promise<DependencyIssue | undefined>;
    readonly requestInstall: (dirs: readonly string[], origin: DependencyRequestOrigin) => Promise<DependencyRequestResult>;
    readonly reconcileLand: (origin: Extract<DependencyOrigin, { kind: "land" }>) => Promise<ReconcileOutcome | undefined>;
    readonly watch: (subscribe: (listener: (paths: string[]) => void) => () => void) => () => void;
    readonly subscribe: (listener: (event: DependencyInstallStarted) => void) => () => void;
    readonly subscribeFailures: (listener: (event: DependencyInstallStartFailed) => void) => () => void;
}

export interface DependencyCoordinatorDeps {
    readonly workspace: { readonly root: string };
    readonly processes: ManagedProcesses;
    readonly logger: Logger;
    readonly requestsPath: string;
    readonly settleMs?: number;
    readonly pollMs?: number;
    readonly installMaxMs?: number;
    // The line an install's command runs as: the heavy table's install lane, which an agent's own install takes too,
    // so the two never rewrite one tree at once. Absent runs the recipe as it is.
    readonly lane?: (command: string) => Promise<string>;
}

const isInside = (project: string, dir: string): boolean => project === "" || dir === project || dir.startsWith(`${project}/`);

// The repository a project sits in: the nearest folder up from it with a `.git` of its own (a nested repo), else the
// workspace's root repo. A folder of the root repo (`video/`) is the root's, not an outsider's.
const repoOf = (root: string, dir: string): string => {
    for (let current = dir; current !== ""; current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "") {
        if (existsSync(join(root, current, ".git"))) {
            return current;
        }
    }
    return "root";
};

// A nested repo claims what lies under its folder; the root repo claims what no nested repo does.
const belongsToLand = (root: string, dir: string, origin: Extract<DependencyOrigin, { kind: "land" }>): boolean =>
    origin.repos.some(({ repo }) => (repo === "root" ? repoOf(root, dir) === "root" : dir === repo || dir.startsWith(`${repo}/`)));

// The directories of every manifest the land carried, workspace-relative ("." for the workspace root), read from each
// repo's checkout between where the turn started and what landed. A repo git cannot answer for carries none, so
// nothing is installed on a guess.
const landedManifests = async (origin: Extract<DependencyOrigin, { kind: "land" }>): Promise<Set<string>> => {
    const dirs = new Set<string>();
    await Promise.all(
        origin.repos.map(async ({ repo, from, dir }) => {
            const changed = await execFileAsync("git", ["-C", dir, "diff", "--name-only", "--diff-filter=AM", from, "HEAD"]).then(
                ({ stdout }) => stdout.split("\n").filter((path) => path !== ""),
                () => [],
            );
            for (const path of changed.filter((each) => isManifest(basename(each)))) {
                const inRepo = dirname(path);
                const rel = repo === "root" ? inRepo : inRepo === "." ? repo : `${repo}/${inRepo}`;
                dirs.add(rel);
            }
        }),
    );
    return dirs;
};

export const createDependencyCoordinator = (deps: DependencyCoordinatorDeps): DependencyCoordinator => {
    const requests = openDocument(dependencyRequestsDocument, deps.requestsPath, { read: requestState, fallback: () => ({ projects: {} }) });
    const causes = new Map<string, DependencyOrigin>();
    const listeners = new Set<(event: DependencyInstallStarted) => void>();
    const failureListeners = new Set<(event: DependencyInstallStartFailed) => void>();
    // Only a background observation sets the fallback; a request or land is remembered per project only.
    let backgroundOrigin: Extract<DependencyOrigin, { kind: "external" | "startup" }> = { kind: "startup" };
    // Skips retrying a failed install until its manifest/lockfile inputs change; an explicit request bypasses this.
    const failedOn = new Map<string, string>();
    let quietAfter = 0;
    let settlingWorkspaceBurst = false;
    let dirty = false;
    let scheduled = false;
    let stopped = false;

    const remember = (dir: string, origin: DependencyOrigin): void => {
        const current = causes.get(dir);
        // A lower-priority cause can't overwrite one attributed; an equal-priority one does, so the later land wins.
        if (current === undefined || originPriority(origin) >= originPriority(current)) {
            causes.set(dir, origin);
        }
    };

    // The install's inputs as one string: size and mtime of every manifest and lockfile in the project.
    const inputsOf = (dir: string): string =>
        ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]
            .map((file) => {
                try {
                    const stat = statSync(join(deps.workspace.root, dir, file));
                    return `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`;
                } catch {
                    return `${file}:-`;
                }
            })
            .join(" ");
    const waitForQuiet = async (): Promise<void> => {
        while (quietAfter > Date.now()) {
            await sleep(quietAfter - Date.now());
        }
        settlingWorkspaceBurst = false;
    };

    const waitForInstalls = async (keys: readonly string[]): Promise<void> => {
        const deadline = Date.now() + (deps.installMaxMs ?? DEFAULT_INSTALL_MAX_MS);
        while (keys.some((key) => deps.processes.running(key)) && Date.now() < deadline) {
            await sleep(deps.pollMs ?? DEFAULT_POLL_MS);
        }
        const timedOut = keys.filter((key) => deps.processes.running(key));
        for (const key of timedOut) {
            deps.logger.warn({ key }, "dependency install exceeded its watch window: stopping it");
            await deps.processes.stop(key);
        }
    };

    const removeRequests = async (dirs: readonly string[]): Promise<void> => {
        if (dirs.length === 0) {
            return;
        }
        const removed = new Set(dirs);
        await requests.update((current) => ({
            projects: Object.fromEntries(Object.entries(current.projects).filter(([dir]) => !removed.has(dir))),
        }));
    };

    // What an install's pane runs: the recipe, in the lane when there is one.
    const installLine = async (project: ProjectSetupStatus): Promise<string> =>
        deps.lane === undefined ? project.recipe.command : deps.lane(project.recipe.command);

    const pass = async (): Promise<void> => {
        const [projects, requested] = await Promise.all([workspaceSetup(deps.workspace.root, deps.processes), requests.read()]);
        const known = new Map(projects.map((project) => [project.dir, project]));
        // A ready or removed project's request is cleared, keeping the durable file a worklist, not a history.
        await removeRequests(
            Object.keys(requested.projects).filter((dir) => {
                const project = known.get(dir);
                return project === undefined || project.state === "ready";
            }),
        );
        for (const dir of causes.keys()) {
            const project = known.get(dir);
            if (project === undefined || (!INSTALLABLE.has(project.state) && project.state !== "installing")) {
                causes.delete(dir);
            }
        }
        const due = projects.filter((project) => {
            if (requested.projects[project.dir] !== undefined && INSTALLABLE.has(project.state)) {
                return true;
            }
            if (project.state !== "stale") {
                return false;
            }
            const failed = failedOn.get(project.dir);
            if (failed !== undefined && failed === inputsOf(project.dir)) {
                return false;
            }
            return true;
        });
        const started: Array<{ dir: string; key: string; requested: boolean }> = [];
        for (const project of due) {
            const requestedOrigin = requested.projects[project.dir];
            const origin = causes.get(project.dir) ?? requestedOrigin ?? backgroundOrigin;
            try {
                await startInstall(deps.workspace.root, project, deps.processes, await installLine(project));
            } catch (error) {
                deps.logger.warn({ err: error, dir: project.dir }, "dependency coordinator: install would not start");
                for (const listener of failureListeners) {
                    try {
                        listener({ dir: project.dir, origin });
                    } catch (listenerError) {
                        deps.logger.warn({ err: listenerError, dir: project.dir }, "dependency coordinator: failure listener threw");
                    }
                }
                continue;
            }
            started.push({ dir: project.dir, key: installPanelKey(project.dir), requested: requestedOrigin !== undefined });
            for (const listener of listeners) {
                try {
                    listener({ dir: project.dir, origin });
                } catch (error) {
                    deps.logger.warn({ err: error, dir: project.dir }, "dependency coordinator: install listener threw");
                }
            }
        }
        if (started.length > 0) {
            deps.logger.info({ projects: started.map(({ dir }) => dir) }, "dependency coordinator: installs started");
            await waitForInstalls(started.map(({ key }) => key));
            const settled = new Map((await workspaceSetup(deps.workspace.root, deps.processes)).map((project) => [project.dir, project]));
            const fulfilled = started
                .filter(({ dir, requested: explicitlyRequested }) => explicitlyRequested && settled.get(dir)?.state === "ready")
                .map(({ dir }) => dir);
            await removeRequests(fulfilled);
            for (const { dir } of started) {
                if (settled.get(dir)?.state === "ready") {
                    causes.delete(dir);
                    failedOn.delete(dir);
                    continue;
                }
                failedOn.set(dir, inputsOf(dir));
                deps.logger.warn(
                    { dir: dir === "" ? "the workspace root" : dir },
                    "dependency coordinator: the install finished but the project is still behind; not retrying until a manifest or lockfile changes",
                );
            }
        }
    };

    const schedule = (origin: DependencyOrigin): void => {
        if (origin.kind === "external") {
            backgroundOrigin = origin;
        }
        dirty = true;
        if (scheduled || stopped) {
            return;
        }
        scheduled = true;
        // One pass at a time: two observations of the same drift can't start the same install twice.
        void (async () => {
            while (dirty) {
                if (stopped) {
                    break;
                }
                dirty = false;
                await waitForQuiet();
                await pass();
            }
        })()
            .catch((error: unknown) => deps.logger.warn({ err: error }, "dependency coordinator: maintenance pass failed"))
            .finally(() => {
                scheduled = false;
                backgroundOrigin = { kind: "external" };
                if (dirty && !stopped) {
                    schedule({ kind: "external" });
                }
            });
    };

    const status = async (): Promise<ProjectSetupStatus[]> => {
        const [projects, requested] = await Promise.all([workspaceSetup(deps.workspace.root, deps.processes), requests.read()]);
        const stale = projects.filter((project) => project.state === "stale");
        for (const project of stale) {
            remember(project.dir, { kind: "external" });
        }
        const requestedDue = projects.filter((project) => requested.projects[project.dir] !== undefined && INSTALLABLE.has(project.state));
        for (const project of requestedDue) {
            remember(project.dir, requested.projects[project.dir] as DependencyRequestOrigin);
        }
        if (stale.length > 0 || requestedDue.length > 0) {
            schedule({ kind: "external" });
        }
        return projects;
    };

    return {
        status,
        issueAt: async (dir) => {
            const projects = await status();
            const project = projects
                .filter((candidate) => isInside(candidate.dir, dir))
                .toSorted((left, right) => right.dir.length - left.dir.length)[0];
            if (project === undefined || (project.state !== "stale" && project.state !== "needs-setup")) {
                return undefined;
            }
            const unresolved =
                project.state === "stale" ? (project.unresolved ?? []) : await unresolvedDependencies(join(deps.workspace.root, project.dir));
            return { dir: project.dir, state: project.state, names: unresolved.flatMap((entry) => entry.names) };
        },
        requestInstall: async (dirs, origin) => {
            const projects = await workspaceSetup(deps.workspace.root, deps.processes);
            const wanted = new Set(dirs);
            const queued = projects.filter((project) => wanted.has(project.dir) && INSTALLABLE.has(project.state)).map((project) => project.dir);
            if (queued.length > 0) {
                await requests.update((current) => ({
                    projects: { ...current.projects, ...Object.fromEntries(queued.map((dir) => [dir, origin])) },
                }));
                for (const dir of queued) {
                    remember(dir, origin);
                }
                schedule(origin);
            }
            return { projects, queued };
        },
        reconcileLand: async (origin) => {
            const projects = await workspaceSetup(deps.workspace.root, deps.processes);
            const stale = projects.filter((project) => project.state === "stale");
            // A project the land brought or first gave a manifest has never been installed in the main tree; the
            // conversation that made it installed it in its own copy, so the main tree owes the same install. Only
            // one whose manifest this land carried: a project dropped in by hand stays uninstalled until asked for.
            const carried = await landedManifests(origin);
            // Read off the landed repos' own diffs, so it needs no repo-membership test (which credits the root repo
            // with the workspace root alone, never with a folder of its own like `video/`).
            const fresh = projects.filter((project) => project.state === "needs-setup" && carried.has(project.dir === "" ? "." : project.dir));
            if (stale.length === 0 && fresh.length === 0) {
                return undefined;
            }
            for (const project of stale) {
                remember(project.dir, belongsToLand(deps.workspace.root, project.dir, origin) ? origin : { kind: "external" });
            }
            if (fresh.length > 0) {
                // Durable like an agent's own request, so a restart before the pass still installs them; the land stays
                // the remembered cause while this process lives.
                const asked: DependencyRequestOrigin = { kind: "request", conversationId: origin.agentId, ...opt("title", origin.title) };
                await requests.update((current) => ({
                    projects: { ...current.projects, ...Object.fromEntries(fresh.map((project) => [project.dir, asked])) },
                }));
                for (const project of fresh) {
                    remember(project.dir, origin);
                }
            }
            schedule({ kind: "external" });
            const caused = stale.filter((project) => belongsToLand(deps.workspace.root, project.dir, origin));
            const declared = await Promise.all(
                fresh.map(async (project) =>
                    (await unresolvedDependencies(join(deps.workspace.root, project.dir)).catch(() => [])).reduce((total, entry) => total + entry.names.length, 0),
                ),
            );
            const missing = caused.reduce((total, project) => total + behindCount(project), 0) + declared.reduce((total, count) => total + count, 0);
            return caused.length === 0 && fresh.length === 0 ? undefined : { missing, started: [], deferred: true };
        },
        watch: (subscribe) => {
            stopped = false;
            const unsubscribe = subscribe((paths) => {
                const manifestChanged = paths.length === 0 || paths.some((path) => isManifest(basename(path)));
                // A manifest arms the settle window; later batches extend it, since source files can follow it by
                // seconds.
                if (!manifestChanged && !settlingWorkspaceBurst) {
                    return;
                }
                settlingWorkspaceBurst = true;
                quietAfter = Date.now() + (deps.settleMs ?? DEFAULT_SETTLE_MS);
                if (manifestChanged) {
                    schedule({ kind: "external" });
                }
            });
            schedule({ kind: "startup" });
            return () => {
                stopped = true;
                unsubscribe();
            };
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        subscribeFailures: (listener) => {
            failureListeners.add(listener);
            return () => failureListeners.delete(listener);
        },
    };
};
