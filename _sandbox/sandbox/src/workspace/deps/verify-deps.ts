import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import { MAINLINE_FAILURES_KEPT, type MainlineLand, type MainlineRouting, type WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ActivityStore } from "../../activity/activity-store.js";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { QUEUE_SKIPPED_EXIT_CODE } from "../../platform/resources/heavy-commands.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { markCheckRunning } from "./checks-in-flight.js";
import type { DependencyLandOrigin, DependencyOrigin } from "./dependency-origin.js";
import { statePath } from "../../state-paths.js";
import type { RecordedVerdict, VerifyStore } from "./verify-store.js";
import { installPanelKey, workspaceSetup } from "../layout/workspace-setup.js";
import { LAND_CHECK_LABEL, offloadPrefix } from "../../offload/offload-prefix.js";

// Runs a project's land check (its repository's declared `land` check, else the `verify` script, else `test`) after its
// install settles, records the verdict and the run, hands a red one to the breakage router (`route`), and emits
// `deps.broken`/`deps.fixed` for a chore to wake on when nobody took them. A causeless run (the reconciler's own
// installs, not a land) still checks and records, but never wakes anyone.
// This is the ONLY verification the sandbox runs on work: nothing checks inside a turn, and nothing here holds a land, a
// commit or a push. It runs one project at a time, and lands that arrive meanwhile wait and are measured together.

export const verifyPanelKey = (dir: string): string => `${dir === "" ? "root" : dir.replace(/[^a-zA-Z0-9_-]/g, "_")}--verify`;

// Tail kept on the event payload (a guard's environment, a prompt); the full log stays one attach away.
const LOG_TAIL = 2_000;
// Poll interval while a check runs; the panel sweep itself only samples every 2s anyway.
const POLL_MS = 2_000;
// Ceiling before a stuck check is stopped, so it can't hold every later verdict behind it forever.
const WATCH_MAX_MS = 30 * 60_000;

export interface VerifyDeps {
    readonly workspace: { readonly root: string };
    readonly processes: ManagedProcesses;
    readonly logger: Logger;
    readonly verifyStore: VerifyStore;
    readonly activity: Pick<ActivityStore, "append">;
    // Injected event sink, so the chain needs no wake fn or full services object; absent for a causeless install.
    readonly emit?: (event: WorkspaceEvent) => void;
    // Says the check wrote the tree where nothing was watching (announceUnwatchedWrite); required, since a check whose
    // writes go unannounced leaves every browser holding whatever it read mid-build.
    readonly announce: () => void;
    // Same queue an agent's turn uses, so a check can't stack beside live turns; absent means unqueued.
    readonly queue?: (command: string) => Promise<string>;
    // The runner the owner sends the check after landing to (settings `offload.landCheck`), undefined to run it here;
    // with it, the queue's own prefix, which offload-run keeps for running the check here when the runner cannot.
    readonly offload?: () => Promise<string | undefined>;
    readonly heavyPrefix?: (command: string) => Promise<string>;
    // Hands every red run to the breakage router, which decides what its failures are owed (mainline.ts's routing kinds);
    // undefined when there was nothing to decide. Anything but `reported` means somebody took it, so no chore wakes too.
    readonly route?: (breakage: LandBreakage) => Promise<MainlineRouting | undefined>;
    // Told when a project comes back green, so whatever `route` counted or held for it starts over.
    readonly settled?: (project: string) => void;
    // Measures again what the project's pushes left open (push-checks.ts), once a land check has moved its main tree: a
    // landed fix clears its findings minutes later. Absent where nothing records pushes.
    readonly recheckPushes?: (project: string) => Promise<unknown>;
    // The land check the project's repository declares and the owner adopted; undefined runs the package's own script.
    readonly landCheck?: (dir: string) => Promise<{ readonly run: string; readonly timeoutMs?: number | undefined } | undefined>;
    // Test dials; the daemon uses the defaults.
    readonly pollMs?: number;
    readonly watchMaxMs?: number;
}

// A red land verdict's news: the failures that appeared with it and the lands its run covered, oldest first.
export interface LandBreakage {
    readonly project: string;
    readonly command: string;
    readonly lands: readonly DependencyLandOrigin[];
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

interface PendingVerify {
    readonly deps: VerifyDeps;
    readonly origin: DependencyOrigin;
    readonly dirs: readonly string[];
    // Every land a coalesced run answers for, oldest first; the check measures their sum.
    readonly lands: readonly DependencyLandOrigin[];
}

// The report a project's check may write (INTENTIC_VERIFY_REPORT): what it failed on, as units it names itself. A `rerun`
// an older check still writes is read past: nothing re-runs failures to tell suspect lands apart any more.
const ReportSchema = z.object({ failures: z.array(z.string()) });
type VerifyReport = z.infer<typeof ReportSchema>;

// The land span's entry for a project dir; the workspace repo is "root" in a span and "" as a dir.
const spanOf = (land: DependencyLandOrigin, dir: string): DependencyLandOrigin["repos"][number] | undefined =>
    land.repos.find(({ repo }) => (repo === "root" ? "" : repo) === dir);

const pending: PendingVerify[] = [];
let running = false;

// When each land asked for its check, for the history and the cards; a land is one object for its whole queue life.
const queuedAt = new WeakMap<DependencyLandOrigin, number>();

// The check under way, for the main-line status; one at a time across every caller.
interface CurrentRun {
    readonly dir: string;
    readonly command: string;
    readonly startedAt: number;
    readonly lands: readonly DependencyLandOrigin[];
    // The runner it was sent to (settings `offload.landCheck`); absent when it runs here.
    readonly on?: string;
}
let current: CurrentRun | undefined;

// A land as the history and the editor name it.
export const mainlineLandOf = (land: DependencyLandOrigin): MainlineLand => ({
    conversationId: land.agentId,
    ...(land.title === undefined ? {} : { title: land.title }),
    at: queuedAt.get(land) ?? 0,
});

// What is running and what waits, as plain data, for the main-line status (mainline-status.ts).
export interface VerifyQueueSnapshot {
    readonly current: CurrentRun | undefined;
    readonly pending: readonly { readonly dirs: readonly string[]; readonly lands: readonly DependencyLandOrigin[] }[];
}

export const verifyQueueSnapshot = (): VerifyQueueSnapshot => ({
    current,
    pending: pending.map(({ dirs, lands }) => ({ dirs, lands })),
});

// Whether lands for `dir` wait behind the run now settling: their check measures this tree again, with them in it.
const queuedBehind = (dir: string): boolean => pending.some((entry) => entry.dirs.includes(dir) && entry.lands.length > 0);

// Whether a check of `dir` that answers for some land is running or waiting: a red found now will be measured again.
export const landCheckAhead = (dir: string): boolean =>
    queuedBehind(dir) || (current !== undefined && current.dir === dir && current.lands.length > 0);

// Waits until `key` stops running or the watch window closes; true means it stopped.
const watchPanel = (deps: VerifyDeps, key: string, timeoutMs?: number): Promise<boolean> =>
    pollUntil(() => !deps.processes.running(key), { intervalMs: deps.pollMs ?? POLL_MS, timeoutMs: timeoutMs ?? deps.watchMaxMs ?? WATCH_MAX_MS });

// A causeless run files under no conversation, which the activity row already supports (both fields optional); blank
// reads as the daemon acting alone, which is what happened.
const activity = (deps: VerifyDeps, type: string, content: string, outcome: "ok" | "error", origin: DependencyOrigin): void => {
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

// The check's command as it will run: queued if the caller gave a queue, else as-is.
const queuedCommand = async (command: string, deps: VerifyDeps): Promise<string> =>
    deps.queue === undefined
        ? command
        : deps.queue(command).catch((error: unknown) => {
              deps.logger.warn({ err: error, command }, "dependency verify: could not queue the check, running it unqueued");
              return command;
          });

// The runner this check goes to, when the owner sends it to one; a setting that cannot be read keeps it here.
const offloadTarget = async (deps: VerifyDeps): Promise<string | undefined> =>
    deps.offload === undefined
        ? undefined
        : await deps.offload().catch((error: unknown) => {
              deps.logger.warn({ err: error }, "dependency verify: could not read where the check runs, running it here");
              return undefined;
          });

// The check handed to offload-run (bin/offload-run): the land's base and the report path travel, the report and the
// tree verdict come back, and the queued form is kept for running it here when the runner cannot take it.
const offloadedCommand = async (command: string, runner: string, deps: VerifyDeps): Promise<string> => {
    const prefix = await (deps.heavyPrefix?.(command) ?? Promise.resolve("")).catch((error: unknown) => {
        deps.logger.warn({ err: error, command }, "dependency verify: could not determine heavy prefix for offloaded check");
        return "";
    });
    return `${offloadPrefix(runner, LAND_CHECK_LABEL, prefix, ["INTENTIC_LAND_FROM"], ["INTENTIC_VERIFY_REPORT", "INTENTIC_VERDICT_OUT"])}bash -c ${shellQuote(command)}`;
};

// A verdict the check recorded on the runner, merged into this repository's own record for the push gate and the base
// verify:turn judges against; the recorder is the repository's own (tree-verdict.mjs), so a repository without one keeps
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

// Where one project's run leaves its log, exit status and report; under .intentic, outside the repo, so a check never
// dirties the tree.
const artifactsOf = (deps: VerifyDeps, dir: string): { key: string; dir: string; log: string; status: string; report: string; verdict: string } => {
    const key = verifyPanelKey(dir);
    const at = statePath(deps.workspace.root, ".intentic/local/verify/");
    return {
        key,
        dir: at,
        log: join(at, `${key}.log`),
        status: join(at, `${key}.status`),
        report: join(at, `${key}.report.json`),
        verdict: join(at, `${key}.verdict.json`),
    };
};

// Runs the check in its panel until it settles or outruns the watch; the wrapped command is one zsh line, and
// `pipestatus[1]` is the check's exit, not tee's.
const runPanel = async (verify: PendingVerify, dir: string, command: string, timeoutMs: number | undefined): Promise<boolean> => {
    const { deps } = verify;
    const paths = artifactsOf(deps, dir);
    const runner = await offloadTarget(deps);
    const queued = runner === undefined ? await queuedCommand(command, deps) : await offloadedCommand(command, runner, deps);
    // What the check is told: where to leave its failures as data, and the main-line commit the oldest land it covers left.
    const from = verify.lands.map((land) => spanOf(land, dir)?.from).find((sha) => sha !== undefined);
    const exported = [
        `export INTENTIC_VERIFY_REPORT=${shellQuote(paths.report)}`,
        ...(from === undefined ? [] : [`export INTENTIC_LAND_FROM=${shellQuote(from)}`]),
        ...(runner === undefined ? [] : [`export INTENTIC_VERDICT_OUT=${shellQuote(paths.verdict)}`]),
    ];
    // Open across the whole run: the build inside it empties and rewrites an output dir the repo may track, and a
    // review scanning mid-build would otherwise report the rewrite as the owner's own deletion.
    const checkDone = markCheckRunning(dir);
    current = { dir, command, startedAt: Date.now(), lands: verify.lands, ...(runner === undefined ? {} : { on: runner }) };
    publishRuntimeChange("mainline");
    try {
        await deps.processes.start(paths.key, {
            command: `mkdir -p ${paths.dir} && rm -f ${paths.status} ${paths.report} ${paths.verdict} && { ${exported.join("; ")}; ${queued}; } 2>&1 | tee ${paths.log}; echo $pipestatus[1] > ${paths.status}${runner === undefined ? "" : verdictMerge(paths.verdict)}`,
            cwd: join(deps.workspace.root, dir),
            oneShot: true,
        });
        return await watchPanel(deps, paths.key, timeoutMs);
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

// Runs one project's check to a verdict: panel up, exit code read back, store updated, edge announced.
const verifyProject = async (verify: PendingVerify, dir: string, command: string, timeoutMs: number | undefined): Promise<void> => {
    const { deps, origin } = verify;
    const paths = artifactsOf(deps, dir);
    const startedAt = Date.now();
    const ran = await runPanel(verify, dir, command, timeoutMs);
    if (!ran) {
        await deps.processes.stop(paths.key);
        activity(
            deps,
            "deps.verify_lost",
            `Checks for ${whereOf(dir)} (${command}) outran the daemon's watch window: verdict not recorded; see the ${paths.key} terminal.`,
            "error",
            origin,
        );
        return;
    }
    const { exitCode, logTail } = await paneOutcome(paths.status, paths.log);
    // The queue ran nothing: its slot stayed held past the wait, and this check may not run beside the holder. Not a
    // verdict, so the store keeps what it had; the next land checks the whole tree again.
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
    await settleVerdict(verify, dir, command, { exitCode, logTail, report: paths.report, key: paths.key, startedAt });
    publishRuntimeChange("mainline");
};

// Records a settled run and says what it means: the activity row, the run in the history, a red one handed to the router,
// and the edge to any chore when nobody took it.
const settleVerdict = async (
    verify: PendingVerify,
    dir: string,
    command: string,
    run: { readonly exitCode: number; readonly logTail: string; readonly report: string; readonly key: string; readonly startedAt: number },
): Promise<void> => {
    const { deps, origin } = verify;
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
            lands: verify.lands.map(mainlineLandOf),
            failures: failures.slice(0, MAINLINE_FAILURES_KEPT),
            failureCount: failures.length,
            attempt: verdict.attempt,
        })
        .catch((error: unknown) => deps.logger.warn({ err: error, project: dir }, "dependency verify: the run could not be filed"));
    // Not awaited: the verdict and its routing never wait on a push's findings.
    void deps
        .recheckPushes?.(dir)
        .catch((error: unknown) => deps.logger.warn({ err: error, project: dir }, "dependency verify: the push findings could not be measured again"));
    if (exitCode === 0) {
        deps.settled?.(dir);
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
            : await routeRed(verify, {
                  project: dir,
                  command,
                  lands: verify.lands,
                  fresh: freshOf(report, verdict, command, exitCode),
                  failures,
                  logTail,
                  runAt: at,
                  redSince: await redSinceOf(deps, dir, at),
                  queuedBehind: queuedBehind(dir),
                  measured: report !== undefined,
              });
    if (routing !== undefined) {
        await deps.verifyStore.routed(dir, at, routing).catch((error: unknown) => deps.logger.warn({ err: error, project: dir }, "dependency verify: routing not filed"));
    }
    // A breakage somebody took wakes no chore as well: one repair per failure.
    if (verdict.edge === "fixed" || (verdict.edge === "broken" && (routing === undefined || routing.kind === "reported"))) {
        announceEdge(verify, dir, command, { exitCode, logTail, edge: verdict.edge, attempt: verdict.attempt });
    }
};

// Emitted only with a cause to name: a chore reads `repos` as a git span to work, which a causeless run lacks.
const announceEdge = (
    verify: PendingVerify,
    dir: string,
    command: string,
    run: { readonly exitCode: number; readonly logTail: string; readonly edge: "broken" | "fixed"; readonly attempt: number },
): void => {
    const { origin } = verify;
    if (origin.kind !== "land") {
        return;
    }
    verify.deps.emit?.({
        event: run.edge === "broken" ? "deps.broken" : "deps.fixed",
        agentId: origin.agentId,
        ...(origin.title !== undefined ? { title: origin.title } : {}),
        branch: origin.branch,
        outcome: "landed",
        repos: origin.repos,
        deps: { project: dir, command, exitCode: run.exitCode, attempt: run.attempt, logTail: run.logTail },
    });
};

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

// When the project's red streak began, as the verdict just recorded says; this run's own end if it cannot be read.
const redSinceOf = async (deps: VerifyDeps, dir: string, at: number): Promise<number> => {
    try {
        return (await deps.verifyStore.read()).projects[dir]?.since ?? at;
    } catch (error) {
        deps.logger.warn({ err: error, project: dir }, "dependency verify: the red streak's start could not be read");
        return at;
    }
};

// Hands a red run to the router, which decides what its failures are owed; undefined when there is no router or it threw.
const routeRed = async (verify: PendingVerify, breakage: LandBreakage): Promise<MainlineRouting | undefined> => {
    if (verify.deps.route === undefined) {
        return undefined;
    }
    return verify.deps.route(breakage).catch((error: unknown) => {
        verify.deps.logger.warn({ err: error, project: breakage.project }, "dependency verify: routing the breakage failed");
        return undefined;
    });
};

// One pass over the pending request. Installs first, or a half-installed tree's failure would misread as the code's
// own.
const runChain = async (verify: PendingVerify): Promise<void> => {
    const { deps, origin } = verify;
    for (const dir of verify.dirs) {
        if (deps.processes.running(installPanelKey(dir)) && !(await watchPanel(deps, installPanelKey(dir)))) {
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
    for (const dir of verify.dirs) {
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
        const declared = await deps.landCheck?.(dir).catch((error: unknown) => {
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
        await verifyProject(verify, dir, command, declared?.timeoutMs);
    }
};

// Queues behind the install that prompted it and never holds a turn out. Origins stay attached to their own batch, so a
// later watcher observation can't erase a land and swallow its wake.
export const queueVerify = (deps: VerifyDeps, origin: DependencyOrigin, dirs: readonly string[]): void => {
    if (dirs.length === 0) {
        return;
    }
    const wanted = [...new Set(dirs)];
    // One check per tree, not per land: a still-pending request for the same dirs is replaced by the newer one, which
    // then answers for the lands the replaced one carried.
    const same = pending.findIndex((entry) => entry.dirs.length === wanted.length && entry.dirs.every((dir) => wanted.includes(dir)));
    const carried = same === -1 ? [] : (pending.splice(same, 1)[0]?.lands ?? []);
    if (origin.kind === "land" && !queuedAt.has(origin)) {
        queuedAt.set(origin, Date.now());
    }
    pending.push({ deps, origin, dirs: wanted, lands: [...carried, ...(origin.kind === "land" ? [origin] : [])] });
    publishRuntimeChange("mainline");
    if (running) {
        return;
    }
    const attempt = (): void => {
        const next = pending.shift();
        if (next === undefined) {
            running = false;
            return;
        }
        running = true;
        void runChain(next)
            .catch((error: unknown) => next.deps.logger.warn({ err: error }, "dependency verify: chain failed"))
            .finally(attempt);
    };
    attempt();
};
