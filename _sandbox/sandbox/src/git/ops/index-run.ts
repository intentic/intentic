import { randomUUID } from "node:crypto";
import { cancellableGit, type GitRunner } from "@intentic/base/git";
import type { CommitResult, GitTarget } from "@intentic/sandbox-contract/schemas/git/git";
import type { IndexRun, IndexRunHold, IndexRunStart } from "@intentic/sandbox-contract/schemas/git/index-run";
import type { Services } from "../../composition.js";
import { gitFailureReason } from "../git.js";

// Stage-all and commit-all as runs (schemas/git/index-run.ts), the push run's shape (push-run.ts) without a terminal:
// started and answered at once, executed under the repo lock, polled for phase and verdict. One per repo: a second
// start of the same request joins the running one, a different one is refused until it settles. Cancelling aborts the
// run's signal, which kills the git it is waiting on (cancellableGit). Memory only: a run exists while it runs and as
// the repo's last verdict until the next start or a restart.

// What the routes hand a run: the request less its repo.
type IndexRunRequest = Omit<IndexRunStart, "repo">;

// The git work, injected so the registry's lifecycle is testable over fakes; the routes wire it to index-targets.ts.
export interface IndexRunSteps {
    // The paths a stage of `target` would hand git, counted for the guardrail and the progress total.
    readonly count: (repo: string, dir: string, target: GitTarget) => Promise<readonly string[]>;
    // What to hold a stage of `paths` for, undefined to go ahead (index-preflight.ts).
    readonly hold: (dir: string, paths: readonly string[]) => Promise<IndexRunHold | undefined>;
    readonly stage: (repo: string, dir: string, target: GitTarget, git: GitRunner) => Promise<void>;
    readonly commit: (dir: string, message: string, git: GitRunner) => Promise<boolean>;
    // The commit route's own answer, read inside the same lock.
    readonly answer: (repo: string, dir: string, committed: boolean) => Promise<CommitResult>;
}

export interface IndexRunDeps {
    readonly logger: Services["logger"];
    readonly perf: Services["perf"];
    // The repo lock every user write and agent land shares (git.routes.ts onRepo); the run waits its turn in it.
    readonly onRepo: <T>(repo: string, task: (dir: string) => Promise<T>) => Promise<T>;
    // Marks the repo committing for the Changes response, from before the lock, as the commit route does.
    readonly whileCommitting: <T>(repo: string, run: () => Promise<T>) => Promise<T>;
    // Drops the memoized scan; the index moved.
    readonly invalidate: () => void;
    readonly steps: IndexRunSteps;
    // Injectable for the test that proves a cancel reaches git; the daemon always kills through cancellableGit.
    readonly gitFor?: (signal: AbortSignal) => GitRunner;
}

// Refused rather than queued: a commit started over a running stage-all would wait minutes behind it with nothing on
// screen saying why.
export class IndexRunBusy extends Error {
    constructor(readonly running: IndexRun) {
        super(`a ${running.op ?? "git"} is already running in ${running.repo}; wait for it or stop it first`);
    }
}

export interface IndexRuns {
    // Resolves with the run as published (its id, `running`), not when it finishes. Throws IndexRunBusy.
    readonly start: (repo: string, request: IndexRunRequest) => IndexRun;
    readonly state: (repo: string) => IndexRun;
    readonly cancel: (repo: string) => void;
}

// How a run's work ended, before it becomes a published verdict.
type Outcome = { readonly kind: "passed"; readonly result?: CommitResult } | { readonly kind: "held"; readonly held: IndexRunHold };

const idle = (repo: string): IndexRun => ({ status: "idle", id: "", repo, command: "", output: "" });

// Two starts are "the same" when they would do the same thing: a double click, or a retry after the tab lost contact.
const requestKey = (request: IndexRunRequest): string =>
    JSON.stringify([request.op, request.target?.paths, request.target?.scope, request.target === undefined, request.message, request.confirmed === true]);

const heldReason = (held: IndexRunHold): string => `held for confirmation: ${String(held.files)} files would be staged`;

// The published runs, one per repo. Republishes a repo's run only while it is still this one and still going: a cancel
// that settled a queued run early must not be overwritten by that run's late no-op, nor a newer run by an older one.
const createRunBoard = (logger: IndexRunDeps["logger"]) => {
    const runs = new Map<string, IndexRun>();
    const live = (running: IndexRun): IndexRun | undefined => {
        const current = runs.get(running.repo);
        return current?.id === running.id && current.status === "running" ? current : undefined;
    };
    const update = (running: IndexRun, patch: Partial<IndexRun>): void => {
        const current = live(running);
        if (current !== undefined) {
            runs.set(current.repo, { ...current, ...patch });
        }
    };
    const settle = (running: IndexRun, verdict: Pick<IndexRun, "status"> & Partial<IndexRun>): void => {
        const current = live(running);
        if (current === undefined) {
            return;
        }
        // A settled run has no phase; everything else it gathered (the file counts) stays on the verdict.
        const { phase: _settledPhase, ...gathered } = current;
        const settled: IndexRun = { ...gathered, ...verdict, finishedAt: Date.now() };
        runs.set(settled.repo, settled);
        logger.info(
            { repo: settled.repo, op: settled.op, status: settled.status, files: settled.files?.total, durationMs: Date.now() - (settled.startedAt ?? Date.now()) },
            "index run: settled",
        );
    };
    return { runs, update, settle };
};

// A run's git work, inside the repo lock, each phase published through `at` as it starts. Undefined when the run was
// stopped while it queued: nothing ran, and the cancel already settled it.
const runSteps = async (
    { steps, invalidate }: Pick<IndexRunDeps, "steps" | "invalidate">,
    repo: string,
    dir: string,
    request: IndexRunRequest,
    { git, signal, at }: { readonly git: GitRunner; readonly signal: AbortSignal; readonly at: (patch: Partial<IndexRun>) => void },
): Promise<Outcome | undefined> => {
    if (signal.aborted) {
        return undefined;
    }
    // A stage with no target is the whole repository; a commit with none records the index as it stands.
    const target = request.op === "stage" ? (request.target ?? {}) : request.target;
    if (target !== undefined) {
        at({ phase: "counting" });
        const paths = await steps.count(repo, dir, target);
        at({ files: { total: paths.length, done: 0 } });
        const held = request.confirmed === true ? undefined : await steps.hold(dir, paths);
        if (held !== undefined) {
            return { kind: "held", held };
        }
        signal.throwIfAborted();
        at({ phase: "staging" });
        await steps.stage(repo, dir, target, git);
        invalidate();
        at({ files: { total: paths.length, done: paths.length } });
    }
    if (request.op === "stage") {
        return { kind: "passed" };
    }
    signal.throwIfAborted();
    at({ phase: "committing" });
    const committed = await steps.commit(dir, request.message ?? "", git);
    invalidate();
    at({ phase: "reading" });
    return { kind: "passed", result: await steps.answer(repo, dir, committed) };
};

export const createIndexRuns = (deps: IndexRunDeps): IndexRuns => {
    const { runs, update, settle } = createRunBoard(deps.logger);
    const keys = new Map<string, string>();
    const controllers = new Map<string, AbortController>();
    const gitFor = deps.gitFor ?? cancellableGit;

    const execute = async (running: IndexRun, request: IndexRunRequest, abort: AbortController): Promise<void> => {
        const locked = (): Promise<Outcome | undefined> =>
            deps.onRepo(running.repo, (dir) =>
                deps.perf.track(`git.${request.op}`, { repo: running.repo, run: true }, () =>
                    runSteps(deps, running.repo, dir, request, { git: gitFor(abort.signal), signal: abort.signal, at: (patch) => update(running, patch) }),
                ),
            );
        try {
            const outcome = await (request.op === "commit" ? deps.whileCommitting(running.repo, locked) : locked());
            if (outcome?.kind === "held") {
                // `error`: nothing ran, the same reading a push that never started gets.
                settle(running, { status: "error", held: outcome.held, reason: heldReason(outcome.held) });
            } else if (outcome !== undefined) {
                settle(running, outcome.result === undefined ? { status: "passed" } : { status: "passed", result: outcome.result });
            }
        } catch (error) {
            // The index can move even on failure (a stage part way, a commit that staged first), so the view is stale
            // regardless.
            deps.invalidate();
            if (abort.signal.aborted) {
                settle(running, { status: "cancelled" });
                return;
            }
            const fallback = request.op === "commit" ? "git refused the commit" : "git could not stage";
            settle(running, { status: "failed", reason: gitFailureReason(error, fallback) });
        }
    };

    return {
        start: (repo, request) => {
            const current = runs.get(repo);
            if (current?.status === "running") {
                if (keys.get(repo) === requestKey(request)) {
                    return current;
                }
                throw new IndexRunBusy(current);
            }
            const running: IndexRun = {
                status: "running",
                id: randomUUID(),
                repo,
                op: request.op,
                phase: "waiting",
                command: request.op === "stage" ? "git add" : "git commit",
                startedAt: Date.now(),
                output: "",
            };
            const abort = new AbortController();
            runs.set(repo, running);
            keys.set(repo, requestKey(request));
            controllers.set(repo, abort);
            // Not awaited: the caller polls the published state; the controller goes once this run is over.
            void execute(running, request, abort).finally(() => {
                if (controllers.get(repo) === abort) {
                    controllers.delete(repo);
                }
            });
            return running;
        },
        state: (repo) => runs.get(repo) ?? idle(repo),
        cancel: (repo) => {
            const current = runs.get(repo);
            controllers.get(repo)?.abort();
            // Still queued behind the lock: settled now rather than when the lock frees, which can be a land's length.
            if (current?.status === "running" && current.phase === "waiting") {
                settle(current, { status: "cancelled" });
            }
        },
    };
};
