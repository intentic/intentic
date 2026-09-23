import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import type { WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ActivityStore } from "../../activity/activity-store.js";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { QUEUE_SKIPPED_EXIT_CODE } from "../../platform/resources/heavy-commands.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { markCheckRunning } from "./checks-in-flight.js";
import type { DependencyLandOrigin, DependencyOrigin } from "./dependency-origin.js";
import { statePath } from "../../state-paths.js";
import type { VerifyStore } from "./verify-store.js";
import { installPanelKey, workspaceSetup } from "../layout/workspace-setup.js";

// Runs a project's own check (`verify` script, else `test`) after its install settles, records the verdict, hands
// failures that appeared with a land back to it (`route`), and emits `deps.broken`/`deps.fixed` for a chore to wake on
// when nobody took them. A causeless run (the reconciler's own installs, not a land) still checks and records, but never
// wakes anyone.

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
    // Hands a red that named new failures to the land that caused them; true when it did, so no chore wakes on it too.
    readonly route?: (breakage: LandBreakage) => Promise<boolean>;
    // Told when a project comes back green, so whatever `route` counted for it starts over.
    readonly settled?: (project: string) => void;
    // Test dials; the daemon uses the defaults.
    readonly pollMs?: number;
    readonly watchMaxMs?: number;
}

// A red land verdict's news: the failures that appeared with it and the lands its run covered, oldest first.
export interface LandBreakage {
    readonly project: string;
    readonly command: string;
    readonly lands: readonly DependencyLandOrigin[];
    readonly fresh: readonly string[];
    readonly logTail: string;
}

interface PendingVerify {
    readonly deps: VerifyDeps;
    readonly origin: DependencyOrigin;
    readonly dirs: readonly string[];
    // Every land a coalesced run answers for, oldest first; the check measures their sum.
    readonly lands: readonly DependencyLandOrigin[];
}

// The report a project's check may write (INTENTIC_VERIFY_REPORT): what it failed on, as units it names itself.
const ReportSchema = z.object({ failures: z.array(z.string()) });

// The land span's entry for a project dir; the workspace repo is "root" in a span and "" as a dir.
const spanOf = (land: DependencyLandOrigin, dir: string): DependencyLandOrigin["repos"][number] | undefined =>
    land.repos.find(({ repo }) => (repo === "root" ? "" : repo) === dir);

const pending: PendingVerify[] = [];
let running = false;

// Waits until `key` stops running or the watch window closes; true means it stopped.
const watchPanel = (deps: VerifyDeps, key: string): Promise<boolean> =>
    pollUntil(() => !deps.processes.running(key), { intervalMs: deps.pollMs ?? POLL_MS, timeoutMs: deps.watchMaxMs ?? WATCH_MAX_MS });

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
    deps.queue === undefined ? command : deps.queue(command).catch(() => command);

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
const artifactsOf = (deps: VerifyDeps, dir: string): { key: string; dir: string; log: string; status: string; report: string } => {
    const key = verifyPanelKey(dir);
    const at = statePath(deps.workspace.root, ".intentic/local/verify/");
    return { key, dir: at, log: join(at, `${key}.log`), status: join(at, `${key}.status`), report: join(at, `${key}.report.json`) };
};

// Runs the check in its panel until it settles or outruns the watch; the wrapped command is one zsh line, and
// `pipestatus[1]` is the check's exit, not tee's.
const runPanel = async (verify: PendingVerify, dir: string, command: string): Promise<boolean> => {
    const { deps } = verify;
    const paths = artifactsOf(deps, dir);
    const queued = await queuedCommand(command, deps);
    // What the check is told: where to leave its failures as data, and the main-line commit the oldest land it covers left.
    const from = verify.lands.map((land) => spanOf(land, dir)?.from).find((sha) => sha !== undefined);
    const exported = [`export INTENTIC_VERIFY_REPORT=${shellQuote(paths.report)}`, ...(from === undefined ? [] : [`export INTENTIC_LAND_FROM=${shellQuote(from)}`])];
    // Open across the whole run: the build inside it empties and rewrites an output dir the repo may track, and a
    // review scanning mid-build would otherwise report the rewrite as the owner's own deletion.
    const checkDone = markCheckRunning(dir);
    try {
        await deps.processes.start(paths.key, {
            command: `mkdir -p ${paths.dir} && rm -f ${paths.status} ${paths.report} && { ${exported.join("; ")}; ${queued}; } 2>&1 | tee ${paths.log}; echo $pipestatus[1] > ${paths.status}`,
            cwd: join(deps.workspace.root, dir),
            oneShot: true,
        });
        return await watchPanel(deps, paths.key);
    } finally {
        // Closed before the announcement, so the rescan it triggers reads the settled tree rather than the held-back
        // one.
        checkDone();
        // `dist/` is pruned from the watcher, so nothing else can say those files came back, and a review scanned
        // mid-build keeps reporting them deleted for as long as it stays cached. Sent however the run ended: it wrote
        // either way.
        deps.announce();
    }
};

// Runs one project's check to a verdict: panel up, exit code read back, store updated, edge announced.
const verifyProject = async (verify: PendingVerify, dir: string, command: string): Promise<void> => {
    const { deps, origin } = verify;
    const paths = artifactsOf(deps, dir);
    if (!(await runPanel(verify, dir, command))) {
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
    await settleVerdict(verify, dir, command, { exitCode, logTail, report: paths.report, key: paths.key });
};

// Records a settled run and says what it means: the activity row, the new failures to the lands that caused them, and
// the edge to any chore when nobody took them.
const settleVerdict = async (
    verify: PendingVerify,
    dir: string,
    command: string,
    run: { readonly exitCode: number; readonly logTail: string; readonly report: string; readonly key: string },
): Promise<void> => {
    const { deps, origin } = verify;
    const { exitCode, logTail } = run;
    const verdict = await deps.verifyStore.record(dir, exitCode === 0 ? "green" : "red", Date.now(), await readReport(run.report));
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
    const routed = await routeFresh(verify, dir, command, verdict.fresh ?? [], logTail);
    // A breakage handed to the land that caused it wakes no chore as well: one repair per failure.
    if (verdict.edge === "fixed" || (verdict.edge === "broken" && !routed)) {
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

// The failures a report named, or undefined when the check wrote none or none that parses.
const readReport = async (path: string): Promise<readonly string[] | undefined> => {
    try {
        return ReportSchema.parse(JSON.parse(await readFile(path, "utf8"))).failures;
    } catch {
        return undefined;
    }
};

// Offers what appeared with this run to the lands it covered; false when there is nothing new or nobody to hand it to.
const routeFresh = async (verify: PendingVerify, dir: string, command: string, fresh: readonly string[], logTail: string): Promise<boolean> => {
    if (fresh.length === 0 || verify.lands.length === 0 || verify.deps.route === undefined) {
        return false;
    }
    return verify.deps.route({ project: dir, command, lands: verify.lands, fresh, logTail }).catch((error: unknown) => {
        verify.deps.logger.warn({ err: error, project: dir }, "dependency verify: routing the breakage failed");
        return false;
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
        const command = await checkCommandFor(deps.workspace.root, dir, status.recipe.manager);
        if (command === undefined) {
            activity(
                deps,
                "deps.verify_skipped",
                `Dependencies installed for ${whereOf(dir)}, but it defines no verify or test script: nothing to check.`,
                "ok",
                origin,
            );
            continue;
        }
        await verifyProject(verify, dir, command);
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
    pending.push({ deps, origin, dirs: wanted, lands: [...carried, ...(origin.kind === "land" ? [origin] : [])] });
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
