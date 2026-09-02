import { basename, join } from "node:path";
import { sleep } from "@intentic/base/async";
import { isManifest } from "@intentic/workspace-setup";
import type { Logger } from "pino";
import { z } from "zod";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { jsonFile } from "../store/json-file.js";
import { unresolvedDependencies } from "./dependency-drift.js";
import { type DependencyOrigin, type DependencyRequestOrigin, originPriority } from "./dependency-origin.js";
import { INSTALLABLE, installPanelKey, missingCount, type ProjectSetupStatus, startInstall, workspaceSetup } from "./workspace-setup.js";

/* Dependency maintenance has one owner. Every path that discovers drift or requests first-time setup feeds this
 * coordinator; none starts a package manager itself. The coordinator waits until manifest writes have actually
 * gone quiet, starts each visible install panel once, and watches those panels until they settle. It runs
 * BESIDE the agents: an install never holds a turn out, so a message sent into a repair starts immediately and
 * the install proceeds in its own terminal where anyone can watch it.
 *
 * Explicit setup requests are durable until the project is ready. Drift needs no durable queue, it is a fact
 * on disk and the startup scan rediscovers it, but its in-memory origin is retained so a land remains the
 * cause even when the filesystem watcher observes the same manifest a moment later. */

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

const requestState = (raw: unknown): RequestState | undefined => {
    const parsed = RequestStateSchema.safeParse(raw);
    if (!parsed.success) {
        return undefined;
    }
    return {
        projects: Object.fromEntries(
            Object.entries(parsed.data.projects).map(([dir, origin]) => [
                dir,
                {
                    kind: "request" as const,
                    ...(origin.conversationId === undefined ? {} : { conversationId: origin.conversationId }),
                    ...(origin.title === undefined ? {} : { title: origin.title }),
                },
            ]),
        ),
    };
};

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
}

const isInside = (project: string, dir: string): boolean => project === "" || dir === project || dir.startsWith(`${project}/`);

const belongsToLand = (dir: string, origin: Extract<DependencyOrigin, { kind: "land" }>): boolean =>
    origin.repos.some(({ repo }) => (dir === "" ? repo === "root" : dir === repo || dir.startsWith(`${repo}/`)));

export const createDependencyCoordinator = (deps: DependencyCoordinatorDeps): DependencyCoordinator => {
    const requests = jsonFile<RequestState>(deps.requestsPath, {
        parse: requestState,
        fallback: () => ({ projects: {} }),
    });
    const causes = new Map<string, DependencyOrigin>();
    const listeners = new Set<(event: DependencyInstallStarted) => void>();
    const failureListeners = new Set<(event: DependencyInstallStartFailed) => void>();
    // Only background observations may be a pass-wide default. A request or land is remembered per project;
    // letting either become the fallback would attribute unrelated stale projects to whichever conversation
    // happened to wake the coordinator at the same time.
    let backgroundOrigin: Extract<DependencyOrigin, { kind: "external" | "startup" }> = { kind: "startup" };
    let quietAfter = 0;
    let settlingWorkspaceBurst = false;
    let dirty = false;
    let scheduled = false;
    let stopped = false;

    const remember = (dir: string, origin: DependencyOrigin): void => {
        const current = causes.get(dir);
        // Lower-priority observations cannot erase an attributed cause, but a newer cause at the same priority
        // must replace the old one (two lands in the same project belong to the later land, not the first one
        // that happened to find it stale).
        if (current === undefined || originPriority(origin) >= originPriority(current)) {
            causes.set(dir, origin);
        }
    };

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

    const pass = async (): Promise<void> => {
        const [projects, requested] = await Promise.all([workspaceSetup(deps.workspace.root, deps.processes), requests.read()]);
        const known = new Map(projects.map((project) => [project.dir, project]));
        // A ready project has fulfilled its request, including the crash window after an install finished but
        // before this daemon could record that fact. A removed project cannot ever fulfil one. Clearing both
        // here keeps the durable file a worklist rather than a history of old requests.
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
        const due = projects.filter(
            (project) => project.state === "stale" || (requested.projects[project.dir] !== undefined && INSTALLABLE.has(project.state)),
        );
        const started: Array<{ dir: string; key: string; requested: boolean }> = [];
        for (const project of due) {
            const requestedOrigin = requested.projects[project.dir];
            const origin = causes.get(project.dir) ?? requestedOrigin ?? backgroundOrigin;
            try {
                await startInstall(deps.workspace.root, project, deps.processes);
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
                }
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
        // One pass at a time, so two observations of the same drift cannot start the same install twice, but
        // nothing outside this loop waits on it.
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
            if (stale.length === 0) {
                return undefined;
            }
            for (const project of stale) {
                remember(project.dir, belongsToLand(project.dir, origin) ? origin : { kind: "external" });
            }
            schedule({ kind: "external" });
            const caused = stale.filter((project) => belongsToLand(project.dir, origin));
            return caused.length === 0
                ? undefined
                : { missing: caused.reduce((total, project) => total + missingCount(project), 0), started: [], deferred: true };
        },
        watch: (subscribe) => {
            stopped = false;
            const unsubscribe = subscribe((paths) => {
                const manifestChanged = paths.length === 0 || paths.some((path) => isManifest(basename(path)));
                // A manifest is the event that arms the settle window. Once it does, every later workspace batch
                // extends the quiet window: a checkout often writes package.json early and source files for
                // seconds afterwards, and installing two seconds after the manifest alone would still run in
                // the middle of that checkout. Before a manifest, ordinary source edits remain free.
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
