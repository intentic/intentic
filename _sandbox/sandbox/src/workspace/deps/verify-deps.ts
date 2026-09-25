import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pollUntil, sleep } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { MAINLINE_FAILURES_KEPT, type MainlineLand, type MainlineRouting, type WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ActivityStore } from "../../activity/activity-store.js";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { QUEUE_SKIPPED_EXIT_CODE } from "../../system/resources/heavy-commands.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { markCheckRunning } from "./checks-in-flight.js";
import type { DependencyOrigin } from "./dependency-origin.js";
import { statePath } from "../../state-paths.js";
import type { QueuedLand, RecordedVerdict, VerifyStore } from "./verify-store.js";
import { installPanelKey, workspaceSetup } from "../layout/workspace-setup.js";
import { LAND_CHECK_LABEL, offloadPrefix } from "../../offload/offload-prefix.js";

// THE LAND CHECK: one service, built once in composition.ts, that every door into it calls (`enqueue`): the land that
// ends a turn, the Land button, and the reconciler's installs. It runs a project's land check (its repository's declared
// `land` check, else the `verify` script, else `test`) after its install settles, records the verdict and the run, has
// the project's push findings measured again, hands a red one to the breakage router (`route`), and emits `deps.broken`
// when the router only reported it (nobody sent) and `deps.fixed` when the project comes back green. A causeless run
// (the reconciler's own installs, not a land) still checks and records, but never wakes anyone.
// This is the ONLY verification the sandbox runs on work: nothing checks inside a turn, and nothing here holds a land, a
// commit or a push. It runs one project at a time. Lands wait in the verify store until a run with a verdict answers
// them, so those that arrive meanwhile, and those a run left without one (skipped by the queue, past the watch window,
// an install that never settled, a restart), are measured together by the next.

export const verifyPanelKey = (dir: string): string => `${dir === "" ? "root" : dir.replace(/[^a-zA-Z0-9_-]/g, "_")}--verify`;

// Tail kept on the event payload (a guard's environment, a prompt); the full log stays one attach away.
const LOG_TAIL = 2_000;
// Poll interval while a check runs; the panel sweep itself only samples every 2s anyway.
const POLL_MS = 2_000;
// Ceiling on a check once it has started, so a stuck one can't hold every later verdict behind it forever.
const WATCH_MAX_MS = 30 * 60_000;
// How long a check may sit in the heavy-command queue before it starts: the queue's own wait (heavy-commands.ts,
// `waitSeconds`, 900 by default) with room to spare. Never charged to the check's own ceiling.
const START_WAIT_MS = 20 * 60_000;

export interface LandCheckDeps {
    readonly workspace: { readonly root: string };
    readonly processes: ManagedProcesses;
    readonly logger: Logger;
    readonly verifyStore: VerifyStore;
    readonly activity: Pick<ActivityStore, "append">;
    // Where `deps.broken`/`deps.fixed` go; only a run a land asked for emits.
    readonly emit: (event: WorkspaceEvent) => void;
    // Says the check wrote the tree where nothing was watching (announceUnwatchedWrite), since a check whose writes go
    // unannounced leaves every browser holding whatever it read mid-build.
    readonly announce: () => void;
    // The heavy-command queue's prefix for a command (empty when no rule matches or the queue stands down), the same
    // queue an agent's turn uses, so a check can't stack beside live turns; offload-run keeps it for running the check
    // here when the runner cannot.
    readonly heavyPrefix: (command: string) => Promise<string>;
    // The runner the owner sends the check after landing to (settings `offload.landCheck`), undefined to run it here.
    readonly offload: () => Promise<string | undefined>;
    // Hands every red run to the breakage router, which decides what its failures are owed (mainline.ts's routing kinds);
    // undefined when there was nothing to decide. Anything but `reported` means somebody took it, so no chore wakes too.
    readonly route: (breakage: LandBreakage) => Promise<MainlineRouting | undefined>;
    // Told when a project comes back green, with when its red streak began, so whatever `route` held for it starts over.
    readonly settled: (project: string, redSince: number | undefined) => Promise<void>;
    // Measures again what the project's pushes left open (push-checks.ts), once a land check has moved its main tree: a
    // landed fix clears its findings minutes later.
    readonly recheckPushes: (project: string) => Promise<unknown>;
    // The land check the project's repository declares and the owner adopted; undefined runs the package's own script.
    readonly declaredCheck: (dir: string) => Promise<{ readonly run: string; readonly timeoutMs?: number | undefined } | undefined>;
    // Test dials; the daemon uses the defaults.
    readonly pollMs?: number;
    readonly watchMaxMs?: number;
    readonly startWaitMs?: number;
}

// A red land verdict's news: the failures that appeared with it and the lands its run covered, oldest first.
export interface LandBreakage {
    readonly project: string;
    readonly command: string;
    readonly lands: readonly QueuedLand[];
    // What appeared with this run: not in the red verdict before it (all of them, after a green).
    readonly fresh: readonly string[];
    // Everything it failed on, fresh or standing; what a failure carried from an earlier run is checked against.
    readonly failures: readonly string[];
    readonly logTail: string;
    // Which run this is, as the history files it: the project and the instant it ended.
    readonly runAt: number;
    // When the project's red streak began; a fresh fix-up's id is derived from it.
    readonly redSince: number;
    // Whether more lands for this project are queued behind it, whose check will measure this tree again.
    readonly queuedBehind: boolean;
    // Whether the check wrote a list at all. A red run with none (a crash, a timeout, a repository whose check writes no
    // report) says nothing about which earlier failures still stand, so nothing carried may be read as resolved by it.
    readonly measured: boolean;
}

// The report a project's check may write (INTENTIC_VERIFY_REPORT): what it failed on, as units it names itself. A `rerun`
// an older check still writes is read past: nothing re-runs failures to tell suspect lands apart any more.
const ReportSchema = z.object({ failures: z.array(z.string()) });
type VerifyReport = z.infer<typeof ReportSchema>;


// The check under way, for the main-line status; one at a time across every caller.
export interface CurrentRun {
    readonly dir: string;
    readonly command: string;
    readonly startedAt: number;
    readonly lands: readonly QueuedLand[];
    // The panel it runs in (verifyPanelKey), for the editor to attach to.
    readonly session: string;
    // The runner it was sent to (settings `offload.landCheck`); absent when it runs here.
    readonly on?: string;
}

// A land as the history and the editor name it.
export const mainlineLandOf = (land: QueuedLand): MainlineLand => ({
    conversationId: land.agentId,
    ...(land.title === undefined ? {} : { title: land.title }),
    at: land.at,
});

export interface LandCheck {
    // A land (or an install) asks for the check in `dirs`: queued behind the install that prompted it, and never holding
    // a turn out. A land waits in the verify store until a run with a verdict answers it.
    readonly enqueue: (origin: DependencyOrigin, dirs: readonly string[]) => void;
    // The check running now, if any, for the main-line status.
    readonly current: () => CurrentRun | undefined;
    // Whether a check of `dir` that answers for some land is running or will run: a red found now is measured again.
    readonly ahead: (dir: string) => Promise<boolean>;
    // At boot: queues a check for every project with lands no run answered before the daemon stopped.
    readonly resume: () => Promise<void>;
}

// One request in the queue: what asked, and where. The lands it answers for are read from the store when it runs.
interface Request {
    readonly origin: DependencyOrigin;
    readonly dirs: readonly string[];
}


// A causeless run files under no conversation, which the activity row already supports (both fields optional); blank
// reads as the daemon acting alone, which is what happened.
const activity = (deps: LandCheckDeps, type: string, content: string, outcome: "ok" | "error", origin: DependencyOrigin): void => {
    const conversationId = origin.kind === "land" ? origin.agentId : origin.kind === "request" ? origin.conversationId : undefined;
    const title = origin.kind === "land" || origin.kind === "request" ? origin.title : undefined;
    void deps.activity
        .append({
            direction: "system",
            type,
            content,
            outcome,
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(title === undefined ? {} : { title }),
        })
        .catch((error: unknown) => deps.logger.warn({ err: error, type }, "dependency verify: activity append failed"));
};

const whereOf = (dir: string): string => (dir === "" ? "the workspace root" : dir);

// The project's own check command, or undefined if it declares none; manager matches what the install used.
export const checkCommandFor = async (root: string, dir: string, manager: string): Promise<string | undefined> => {
    let scripts: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(await readFile(join(root, dir, "package.json"), "utf8"));
        const field = typeof parsed === "object" && parsed !== null ? (parsed as { scripts?: unknown }).scripts : undefined;
        if (typeof field !== "object" || field === null) {
            return undefined;
        }
        scripts = field as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const script = ["verify", "test"].find((name) => typeof scripts[name] === "string");
    return script === undefined ? undefined : `${manager} run ${script}`;
};

// The heavy-command queue's prefix for the check; a rule table that cannot be read runs it unqueued.
const prefixOf = async (deps: LandCheckDeps, command: string): Promise<string> =>
    deps.heavyPrefix(command).catch((error: unknown) => {
        deps.logger.warn({ err: error, command }, "dependency verify: could not queue the check, running it unqueued");
        return "";
    });

// The check as it runs here: it first marks that it started, inside the queue, so the time it waited for a slot is never
// charged to its own ceiling.
const localCommand = async (deps: LandCheckDeps, command: string, startedMark: string): Promise<string> => {
    const marked = `: > ${shellQuote(startedMark)}; ${command}`;
    const prefix = await prefixOf(deps, command);
    return prefix === "" ? marked : `${prefix}bash -c ${shellQuote(marked)}`;
};

// The runner this check goes to, when the owner sends it to one; a setting that cannot be read keeps it here.
const landCheckRunner = async (deps: LandCheckDeps): Promise<string | undefined> =>
    deps.offload().catch((error: unknown) => {
        deps.logger.warn({ err: error }, "dependency verify: could not read where the check runs, running it here");
        return undefined;
    });

// The check handed to offload-run (bin/offload-run): the land's base and the report path travel, the report and the
// tree verdict come back, and the queued form is kept for running it here when the runner cannot take it.
const offloadedCommand = async (deps: LandCheckDeps, command: string, runner: string): Promise<string> =>
    `${offloadPrefix(runner, LAND_CHECK_LABEL, await prefixOf(deps, command), ["INTENTIC_LAND_FROM"], ["INTENTIC_VERIFY_REPORT", "INTENTIC_VERDICT_OUT"])}bash -c ${shellQuote(command)}`;

// A verdict the check recorded on the runner, merged into this repository's own record for the push check to replay; the recorder is the repository's own (tree-verdict.mjs), so a repository without one keeps
// none, as it would here.
const VERDICT_RECORDER = "_tools/scripts/lib/tree-verdict.mjs";
const verdictMerge = (verdict: string): string =>
    `; [ -f ${shellQuote(verdict)} ] && [ -f ${VERDICT_RECORDER} ] && node ${VERDICT_RECORDER} merge ${shellQuote(verdict)} >/dev/null 2>&1`;

// What the pane left behind. No status file is -1, the pane having died before the wrapper's echo, and unknown is not
// green; no log is an empty tail.
const paneOutcome = async (statusPath: string, logPath: string): Promise<{ readonly exitCode: number; readonly logTail: string }> => {
    const status = await readFile(statusPath, "utf8")
        .then((text) => Number.parseInt(text.trim(), 10))
        .catch(() => Number.NaN);
    const logTail = await readFile(logPath, "utf8")
        .then((text) => text.slice(-LOG_TAIL))
        .catch(() => "");
    return { exitCode: Number.isNaN(status) ? -1 : status, logTail };
};

// Where one project's run leaves its log, exit status, report and start mark; under .intentic, outside the repo, so a
// check never dirties the tree.
const artifactsOf = (deps: LandCheckDeps, dir: string) => {
    const key = verifyPanelKey(dir);
    const at = statePath(deps.workspace.root, ".intentic/local/verify/");
    return {
        key,
        dir: at,
        log: join(at, `${key}.log`),
        status: join(at, `${key}.status`),
        report: join(at, `${key}.report.json`),
        verdict: join(at, `${key}.verdict.json`),
        started: join(at, `${key}.started`),
    };
};

// When the check marked its start, or undefined while it still waits in the queue (or runs on a runner, which marks
// nothing here).
const startedAt = async (mark: string): Promise<number | undefined> =>
    stat(mark)
        .then((stats) => stats.mtimeMs)
        .catch(undefinedIfMissing);

// Waits until the panel stops or the check outruns its ceiling; true means it stopped. The ceiling is counted from the
// check's own start: a check still waiting for a queue slot has START_WAIT_MS before its ceiling starts regardless.
const watchRun = async (deps: LandCheckDeps, key: string, mark: string, ceilingMs: number): Promise<boolean> => {
    const launched = Date.now();
    let started: number | undefined;
    for (;;) {
        if (!deps.processes.running(key)) {
            return true;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling is sequential by definition
        started ??= await startedAt(mark);
        if (Date.now() >= (started ?? launched + (deps.startWaitMs ?? START_WAIT_MS)) + ceilingMs) {
            return false;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the wait between probes
        await sleep(deps.pollMs ?? POLL_MS);
    }
};

// Waits until an install panel stops or the watch window closes; true means it stopped.
const watchInstall = (deps: LandCheckDeps, key: string): Promise<boolean> =>
    pollUntil(() => !deps.processes.running(key), { intervalMs: deps.pollMs ?? POLL_MS, timeoutMs: deps.watchMaxMs ?? WATCH_MAX_MS });

// What a report named, or undefined when the check wrote none or none that parses.
const readReport = async (path: string): Promise<VerifyReport | undefined> => {
    try {
        return ReportSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
        return undefined;
    }
};

// What appeared with a red run. A check that names its failures is read unit by unit against the red before it; one that
// names none has one failure, itself, but only where it turned the project red: a red that follows a red with no list
// on either side cannot say whether anything new broke, and blaming every land of it would send people after nothing.
const freshOf = (report: VerifyReport | undefined, verdict: RecordedVerdict, command: string, exitCode: number): readonly string[] => {
    if (report !== undefined) {
        return verdict.fresh ?? [];
    }
    return verdict.attempt === 1 ? [`${command} exited ${exitCode} without naming its failures`] : [];
};

// Emitted only with a cause to name: a chore reads `repos` as a git span to work, which a causeless run lacks.
const announceEdge = (
    deps: LandCheckDeps,
    origin: DependencyOrigin,
    dir: string,
    command: string,
    run: { readonly exitCode: number; readonly logTail: string; readonly edge: "broken" | "fixed"; readonly attempt: number },
): void => {
    if (origin.kind !== "land") {
        return;
    }
    deps.emit({
        event: run.edge === "broken" ? "deps.broken" : "deps.fixed",
        agentId: origin.agentId,
        ...(origin.title !== undefined ? { title: origin.title } : {}),
        branch: origin.branch,
        outcome: "landed",
        repos: origin.repos,
        deps: { project: dir, command, exitCode: run.exitCode, attempt: run.attempt, logTail: run.logTail },
    });
};

// The land span's entry for a project dir; the workspace repo is "root" in a span and "" as a dir.
const spanOf = (land: QueuedLand, dir: string): QueuedLand["repos"][number] | undefined => land.repos.find(({ repo }) => (repo === "root" ? "" : repo) === dir);

export const createLandCheck = (deps: LandCheckDeps): LandCheck => {
    const queue: Request[] = [];
    let running = false;
    let current: CurrentRun | undefined;

    const owedIn = async (dir: string): Promise<readonly QueuedLand[]> =>
        (await deps.verifyStore.lands().catch((error: unknown) => {
            deps.logger.warn({ err: error, project: dir }, "dependency verify: the lands waiting for the check could not be read");
            return {} as Readonly<Record<string, readonly QueuedLand[]>>;
        }))[dir] ?? [];

    // Whether lands for `dir` wait behind the run now settling, with a check queued for them: it measures this tree again.
    const queuedBehind = async (dir: string, answered: readonly QueuedLand[]): Promise<boolean> =>
        queue.some((request) => request.dirs.includes(dir)) &&
        (await owedIn(dir)).some((land) => !answered.some((covered) => covered.agentId === land.agentId && covered.at === land.at));

    // Runs the check in its panel until it settles or outruns its ceiling; the wrapped command is one zsh line, and
    // `pipestatus[1]` is the check's exit, not tee's.
    const runPanel = async (dir: string, command: string, lands: readonly QueuedLand[], ceilingMs: number): Promise<boolean> => {
        const paths = artifactsOf(deps, dir);
        const runner = await landCheckRunner(deps);
        const wrapped = runner === undefined ? await localCommand(deps, command, paths.started) : await offloadedCommand(deps, command, runner);
        // What the check is told: where to leave its failures as data, and the main-line commit the oldest land it covers left.
        const from = lands.map((land) => spanOf(land, dir)?.from).find((sha) => sha !== undefined);
        const exported = [
            `export INTENTIC_VERIFY_REPORT=${shellQuote(paths.report)}`,
            ...(from === undefined ? [] : [`export INTENTIC_LAND_FROM=${shellQuote(from)}`]),
            ...(runner === undefined ? [] : [`export INTENTIC_VERDICT_OUT=${shellQuote(paths.verdict)}`]),
        ];
        // Open across the whole run: the build inside it empties and rewrites an output dir the repo may track, and a
        // review scanning mid-build would otherwise report the rewrite as the owner's own deletion.
        const checkDone = markCheckRunning(dir);
        current = { dir, command, startedAt: Date.now(), lands, session: paths.key, ...(runner === undefined ? {} : { on: runner }) };
        publishRuntimeChange("mainline");
        try {
            await deps.processes.start(paths.key, {
                command: `mkdir -p ${paths.dir} && rm -f ${paths.status} ${paths.report} ${paths.verdict} ${paths.started} && { ${exported.join("; ")}; ${wrapped}; } 2>&1 | tee ${paths.log}; echo $pipestatus[1] > ${paths.status}${runner === undefined ? "" : verdictMerge(paths.verdict)}`,
                cwd: join(deps.workspace.root, dir),
                oneShot: true,
                workload: "toolchain",
            });
            return await watchRun(deps, paths.key, paths.started, ceilingMs);
        } finally {
            // Closed before the announcement, so the rescan it triggers reads the settled tree rather than the held-back
            // one.
            checkDone();
            // However the run ended, a panel that never started included: nothing runs now for the status or the router.
            current = undefined;
            publishRuntimeChange("mainline");
            // `dist/` is pruned from the watcher, so nothing else can say those files came back, and a review scanned
            // mid-build keeps reporting them deleted for as long as it stays cached. Sent however the run ended: it wrote
            // either way.
            deps.announce();
        }
    };

    // Records a settled run and says what it means: the activity row, the run in the history (which answers its lands),
    // a red one handed to the router, and the edge to any chore when nobody took it.
    const settleVerdict = async (
        request: Request,
        dir: string,
        command: string,
        lands: readonly QueuedLand[],
        run: { readonly exitCode: number; readonly logTail: string; readonly report: string; readonly key: string; readonly startedAt: number },
    ): Promise<void> => {
        const { origin } = request;
        const { exitCode, logTail } = run;
        const report = await readReport(run.report);
        const at = Date.now();
        const status = exitCode === 0 ? "green" : "red";
        const verdict = await deps.verifyStore.record(dir, status, at, report?.failures);
        const failures = report?.failures ?? [];
        await deps.verifyStore
            .noteRun({
                project: dir,
                command,
                status,
                startedAt: run.startedAt,
                at,
                lands: lands.map(mainlineLandOf),
                failures: failures.slice(0, MAINLINE_FAILURES_KEPT),
                failureCount: failures.length,
                attempt: verdict.attempt,
            })
            .catch((error: unknown) => deps.logger.warn({ err: error, project: dir }, "dependency verify: the run could not be filed"));
        // Not awaited: the verdict and its routing never wait on a push's findings.
        void deps
            .recheckPushes(dir)
            .catch((error: unknown) => deps.logger.warn({ err: error, project: dir }, "dependency verify: the push findings could not be measured again"));
        if (exitCode === 0) {
            void deps
                .settled(dir, verdict.since)
                .catch((error: unknown) => deps.logger.warn({ err: error, project: dir }, "dependency verify: the router could not start the project over"));
            activity(deps, "deps.verify_green", `Checks green for ${whereOf(dir)} (${command}).`, "ok", origin);
        } else {
            activity(
                deps,
                "deps.verify_red",
                `Checks failed for ${whereOf(dir)} (${command}, exit ${exitCode}, attempt ${verdict.attempt}): full output in the ${run.key} terminal.`,
                "error",
                origin,
            );
        }
        const routing =
            exitCode === 0
                ? undefined
                : await deps
                      .route({
                          project: dir,
                          command,
                          lands,
                          fresh: freshOf(report, verdict, command, exitCode),
                          failures,
                          logTail,
                          runAt: at,
                          redSince: verdict.since ?? at,
                          queuedBehind: await queuedBehind(dir, lands),
                          measured: report !== undefined,
                      })
                      .catch((error: unknown): MainlineRouting => {
                          deps.logger.warn({ err: error, project: dir }, "dependency verify: routing the breakage failed");
                          // Nobody was sent, and nobody else will be: escalated as reported, which is what wakes a person.
                          return { kind: "reported", at: Date.now(), detail: "The sandbox could not decide who fixes it; it waits for you." };
                      });
        if (routing !== undefined) {
            await deps.verifyStore.routed(dir, at, routing).catch((error: unknown) => deps.logger.warn({ err: error, project: dir }, "dependency verify: routing not filed"));
        }
        // A red is the router's to answer (land-breakage.ts): only one it escalated as reported, with nobody sent, wakes
        // whatever reacts to `deps.broken`, so no automation ever becomes a second fixer on a red the router took.
        if (verdict.edge === "fixed" || (verdict.edge === "broken" && routing?.kind === "reported")) {
            announceEdge(deps, origin, dir, command, { exitCode, logTail, edge: verdict.edge, attempt: verdict.attempt });
        }
    };

    // Runs one project's check to a verdict: panel up, exit code read back, store updated. A run that ends without one
    // leaves its lands waiting, so the next run answers for them too.
    const verifyProject = async (request: Request, dir: string, command: string, timeoutMs: number | undefined): Promise<void> => {
        const { origin } = request;
        const paths = artifactsOf(deps, dir);
        const lands = await owedIn(dir);
        const began = Date.now();
        const ran = await runPanel(dir, command, lands, timeoutMs ?? deps.watchMaxMs ?? WATCH_MAX_MS);
        if (!ran) {
            await deps.processes.stop(paths.key);
            activity(
                deps,
                "deps.verify_lost",
                `Checks for ${whereOf(dir)} (${command}) outran the daemon's watch window: verdict not recorded; the next check answers for its lands. See the ${paths.key} terminal.`,
                "error",
                origin,
            );
            return;
        }
        const { exitCode, logTail } = await paneOutcome(paths.status, paths.log);
        // The queue ran nothing: its slot stayed held past the wait, and this check may not run beside the holder. Not a
        // verdict, so the store keeps what it had; the next land checks the whole tree again, answering for these too.
        if (exitCode === QUEUE_SKIPPED_EXIT_CODE) {
            activity(
                deps,
                "deps.verify_deferred",
                `Checks for ${whereOf(dir)} (${command}) did not run: the heavy-command queue had no free slot within its wait, and this check must not run beside another. The next land checks again.`,
                "ok",
                origin,
            );
            return;
        }
        await settleVerdict(request, dir, command, lands, { exitCode, logTail, report: paths.report, key: paths.key, startedAt: began });
    };

    // One pass over a request. Installs first, or a half-installed tree's failure would misread as the code's own.
    const runChain = async (request: Request): Promise<void> => {
        const { origin } = request;
        for (const dir of request.dirs) {
            if (deps.processes.running(installPanelKey(dir)) && !(await watchInstall(deps, installPanelKey(dir)))) {
                await deps.processes.stop(installPanelKey(dir));
                activity(
                    deps,
                    "deps.install_lost",
                    `Install for ${whereOf(dir)} outran the daemon's watch window: checks not run; see the ${installPanelKey(dir)} terminal.`,
                    "error",
                    origin,
                );
                return;
            }
        }
        const statuses = await workspaceSetup(deps.workspace.root, deps.processes);
        for (const dir of request.dirs) {
            const status = statuses.find((project) => project.dir === dir);
            if (status === undefined) {
                continue;
            }
            if (status.state !== "ready") {
                // An unready project after install failed; a chore can't fix that, so this just tells the owner.
                activity(
                    deps,
                    "deps.install_failed",
                    `Install for ${whereOf(dir)} finished but the project is still ${status.state}: checks not run; see the ${installPanelKey(dir)} terminal.`,
                    "error",
                    origin,
                );
                continue;
            }
            const declared = await deps.declaredCheck(dir).catch((error: unknown) => {
                deps.logger.warn({ err: error, project: dir }, "dependency verify: could not read the declared land check, running the project's own script");
                return undefined;
            });
            const command = declared?.run ?? (await checkCommandFor(deps.workspace.root, dir, status.recipe.manager));
            if (command === undefined) {
                activity(
                    deps,
                    "deps.verify_skipped",
                    `Dependencies installed for ${whereOf(dir)}, but it declares no land check and defines no verify or test script: nothing to check.`,
                    "ok",
                    origin,
                );
                continue;
            }
            await verifyProject(request, dir, command, declared?.timeoutMs);
        }
    };

    const drain = (): void => {
        const next = queue.shift();
        if (next === undefined) {
            running = false;
            return;
        }
        running = true;
        void runChain(next)
            .catch((error: unknown) => deps.logger.warn({ err: error }, "dependency verify: chain failed"))
            .finally(drain);
    };

    // One check per tree, not per land: a still-queued request for the same dirs is replaced by the newer one, whose
    // run answers for every land waiting there anyway.
    const push = (origin: DependencyOrigin, dirs: readonly string[]): void => {
        const same = queue.findIndex((request) => request.dirs.length === dirs.length && request.dirs.every((dir) => dirs.includes(dir)));
        if (same !== -1) {
            queue.splice(same, 1);
        }
        queue.push({ origin, dirs });
        publishRuntimeChange("mainline");
        if (!running) {
            drain();
        }
    };

    // Filed before it is queued, so the run that starts on it reads it; a store that cannot take it still gets the check.
    const enqueue = (origin: DependencyOrigin, dirs: readonly string[]): void => {
        if (dirs.length === 0) {
            return;
        }
        const wanted = [...new Set(dirs)];
        if (origin.kind !== "land") {
            push(origin, wanted);
            return;
        }
        void deps.verifyStore
            .owe(wanted, { ...origin, at: Date.now() })
            .catch((error: unknown) => deps.logger.warn({ err: error, conversationId: origin.agentId }, "dependency verify: the land could not be filed as waiting"))
            .then(() => push(origin, wanted));
    };

    return {
        enqueue,
        current: () => current,
        ahead: async (dir) => (current !== undefined && current.dir === dir && current.lands.length > 0) || queuedBehind(dir, current?.dir === dir ? current.lands : []),
        resume: async () => {
            const waiting = await deps.verifyStore.lands();
            for (const dir of Object.keys(waiting).toSorted()) {
                if ((waiting[dir]?.length ?? 0) > 0) {
                    enqueue({ kind: "startup" }, [dir]);
                }
            }
        },
    };
};
