import type { DeviceReport } from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { ensureProjectRepo } from "../git/remote/project-repo.js";
import { attachedProjects, registerProject, reportedProjects } from "../system/projects-registry.js";
import { announceRepoChange } from "../workspace/watch/repo-watch.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { convergeProjectNote } from "./project-note.js";

// A PROJECTS HOST takes in the folders attached to it (system/projects-registry.ts): each becomes a repo of its own, as a
// project sandbox's one folder does (git/remote/project-repo.ts), and the workspace's AGENTS.md names every one. A boot
// re-ensures them all; after it, each report from this computer's machine agent that names a folder not yet attached
// attaches it. Here in the boot wiring because it reaches the git layout, the note and the repo watch, and the report it
// starts from arrives at hosts/desktop-sync.ts, which hears of it through a subscription rather than an import.

// What a line says beside its message: the folders it is about, and the error when one failed.
export interface ProjectsHostLogFields {
    readonly repo?: string;
    readonly repos?: readonly string[];
    readonly outcome?: string;
    readonly err?: unknown;
}

// What it says, and where: the daemon's logger, or a test listening.
export interface ProjectsHostLogger {
    readonly info: (fields: ProjectsHostLogFields, message: string) => void;
    readonly warn: (fields: ProjectsHostLogFields, message: string) => void;
}

export interface ProjectsHostDeps {
    readonly workspace: WorkspacePaths;
    readonly historyRoot: string;
    readonly logger: ProjectsHostLogger;
    // Whether this daemon writes the workspace's agent-facing config (traits.ownsWorkspaceConfig), the note among it.
    readonly writesNote: boolean;
    readonly git?: GitRunner;
}

// The note names every attached folder; said only when it changed.
const noteAttached = async (deps: ProjectsHostDeps, names: readonly string[]): Promise<void> => {
    if (deps.writesNote && (await convergeProjectNote(deps.workspace.root, names))) {
        deps.logger.info({ repos: names }, "attached project folders: the workspace's AGENTS.md names every one as the owner's");
    }
};

// One folder made a repo, and logged only when that changed something; a failure is the caller's to say.
const ensureRepo = async (deps: ProjectsHostDeps, name: string): Promise<void> => {
    const outcome = await ensureProjectRepo(deps.workspace, deps.historyRoot, name, deps.git);
    if (outcome === "created" || outcome === "pointer restored") {
        deps.logger.info({ repo: name, outcome }, "attached project folder: its repo is in place, with its git dir on /history");
    }
};

// What a boot does: every attached folder's repo, then the note. One folder that cannot be made a repo is said and
// skipped, so it costs the others nothing.
export const convergeAttachedProjects = async (deps: ProjectsHostDeps): Promise<void> => {
    const names = await attachedProjects(deps.historyRoot);
    for (const name of names) {
        await ensureRepo(deps, name).catch((error) =>
            deps.logger.warn({ err: error, repo: name }, "attached project folder not made a repo, its files read as the workspace's own in the Changes review"),
        );
    }
    await noteAttached(deps, names);
};

// Attaches each folder the report names that is not attached yet: its repo first, then its name, so a folder whose repo
// could not be made is tried again by the next report rather than kept as attached. Then the note is rewritten to name
// it too, and open editors are told the repo set moved. Answers the names it attached; a report naming nothing new, the
// one nearly every report is, reads the registry and writes nothing.
export const attachReportedProjects = async (deps: ProjectsHostDeps, report: DeviceReport): Promise<string[]> => {
    const reported = reportedProjects(report);
    if (reported.length === 0) {
        return [];
    }
    const known = new Set(await attachedProjects(deps.historyRoot));
    const attached: string[] = [];
    for (const name of reported.filter((candidate) => !known.has(candidate))) {
        try {
            await ensureRepo(deps, name);
            await registerProject(deps.historyRoot, name);
            attached.push(name);
        } catch (error) {
            deps.logger.warn({ err: error, repo: name }, "attached project folder not made a repo, the next report from its computer tries again");
        }
    }
    if (attached.length === 0) {
        return attached;
    }
    deps.logger.info({ repos: attached }, "project folders attached to this computer's sandbox");
    await noteAttached(deps, await attachedProjects(deps.historyRoot)).catch((error) =>
        deps.logger.warn({ err: error }, "project note not rewritten, agents are not told about the folders just attached"),
    );
    announceRepoChange();
    return attached;
};

// One attach at a time, in the order the reports came: the machine agent reports every few seconds, so two reports name
// a new folder before the first has attached it, and two inits of one repo would race. Each report waits for the one
// before it, whatever became of that one.
export const projectsHostAttacher = (deps: ProjectsHostDeps): ((report: DeviceReport) => Promise<void>) => {
    let queue: Promise<unknown> = Promise.resolve();
    return (report) => {
        const next = queue
            .then(() => attachReportedProjects(deps, report))
            .then(
                () => undefined,
                (error) => deps.logger.warn({ err: error }, "a sync report's project folders were not taken in, the next report tries again"),
            );
        queue = next;
        return next;
    };
};
