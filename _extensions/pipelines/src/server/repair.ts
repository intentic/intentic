import { errorMessage } from "@intentic/base/errors";
import type { ActivityRow, Disposable } from "@intentic/extension-api";
import type { CiMainLine, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { PipelinesDaemon } from "./daemon.js";
import type { Logger, LogFields } from "./log.js";
import type { RepairStore } from "./repair-store.js";

/* WHAT MAIN'S FIX AGENT WORKS WITH (2026-11-26), in place of the daemon's services it had until it moved here: the daemon's
   doors (daemon.ts), its own record (repair-store.ts), the log and the activity feed, the owner's switch, the runs the
   CI feed told of, work held while a run's failures wait to be handed over, and where failed jobs' logs are kept. */

// A repository wired to CI, as the core names it with its main line (GET /ci/main-lines).
export type CiProject = CiMainLine;

export interface Repair {
    readonly daemon: PipelinesDaemon;
    readonly store: RepairStore;
    readonly logger: Logger;
    // A row in the sandbox's activity feed (`ci.repair_started`, …), which the SDLC scoreboard counts.
    readonly activity: (row: ActivityRow) => Promise<void>;
    // The extension's own `autoRepair` setting: off, main's failure is only reported.
    readonly autoRepair: () => Promise<boolean>;
    // A run the CI feed told of, by its repository and id: what a job's own frame does not say of it (what set it off).
    readonly knownRun: (repo: string, runId: number) => PipelineRun | undefined;
    // Work in flight (`api.work.hold`): a run's failures parked for their handover keep the sandbox from an update.
    readonly hold: (label: string) => Disposable;
    // Where failed jobs' whole logs are kept for the fix agent to read (job-logs.ts).
    readonly logsRoot: string;
}

// Where a best-effort step failed, for its log line.
export type Where = LogFields;

// A best-effort step: what it answers, or, when it throws, the fallback, with the failure logged. Nothing the fixer does
// may fail the frame or the pass that brought it the news.
export const orElse = async <T>(repair: Pick<Repair, "logger">, work: Promise<T>, fallback: T, message: string, where: Where): Promise<T> => {
    try {
        return await work;
    } catch (error) {
        repair.logger.warn({ ...where, err: errorMessage(error) }, message);
        return fallback;
    }
};

export const tell = (repair: Pick<Repair, "activity" | "logger">, type: string, content: string, outcome: "ok" | "error", conversationId?: string): void => {
    void orElse(repair, repair.activity({ type, content, outcome, conversationId }), undefined, "ci repair: activity append failed", { type });
};

// The repository a main line's news is about, as the core maps it now; undefined for one no longer wired to CI.
export const projectOf = async (repair: Pick<Repair, "daemon">, repo: string): Promise<CiProject | undefined> =>
    (await repair.daemon.mainLines()).find((line) => line.repo === repo);

// Whether a failure on this branch is main's: any other branch is somebody's work in progress.
export const isMainLine = (project: CiProject, branch: string): boolean => project.branches.includes(branch);
