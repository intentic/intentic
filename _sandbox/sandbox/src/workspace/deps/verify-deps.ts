import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import type { WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ActivityStore } from "../../activity/activity-store.js";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import type { DependencyOrigin } from "./dependency-origin.js";
import { statePath } from "../layout/state-paths.js";
import type { VerifyStore } from "./verify-store.js";
import { installPanelKey, workspaceSetup } from "../layout/workspace-setup.js";

// Runs a project's own check (`verify` script, else `test`) after its install settles, records the verdict, and emits
// `deps.broken`/`deps.fixed` for a chore to wake on. A causeless run (the reconciler's own installs, not a land) still
// checks and records, but never wakes anyone.

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
    // Same queue an agent's turn uses, so a check can't stack beside live turns; absent means unqueued.
    readonly queue?: (command: string) => Promise<string>;
    // Test dials; the daemon uses the defaults.
    readonly pollMs?: number;
    readonly watchMaxMs?: number;
}

interface PendingVerify {
    readonly deps: VerifyDeps;
    readonly origin: DependencyOrigin;
    readonly dirs: readonly string[];
}

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

// Runs one project's check to a verdict: panel up, exit code read back, store updated, edge announced. The wrapped
// command is one zsh line; `pipestatus[1]` is the check's exit, not tee's.
const verifyProject = async (verify: PendingVerify, dir: string, command: string): Promise<void> => {
    const { deps, origin } = verify;
    const key = verifyPanelKey(dir);
    // Under .intentic, outside the repo, so a check never dirties the tree; statePath keeps the name in step.
    const artifacts = statePath(deps.workspace.root, ".intentic/local/verify/");
    const logPath = join(artifacts, `${key}.log`);
    const statusPath = join(artifacts, `${key}.status`);
    const queued = await queuedCommand(command, deps);
    await deps.processes.start(key, {
        command: `mkdir -p ${artifacts} && rm -f ${statusPath} && { ${queued}; } 2>&1 | tee ${logPath}; echo $pipestatus[1] > ${statusPath}`,
        cwd: join(deps.workspace.root, dir),
        oneShot: true,
    });
    if (!(await watchPanel(deps, key))) {
        await deps.processes.stop(key);
        activity(
            deps,
            "deps.verify_lost",
            `Checks for ${whereOf(dir)} (${command}) outran the daemon's watch window: verdict not recorded; see the ${key} terminal.`,
            "error",
            origin,
        );
        return;
    }
    let exitCode = -1;
    try {
        const status = Number.parseInt((await readFile(statusPath, "utf8")).trim(), 10);
        exitCode = Number.isNaN(status) ? -1 : status;
    } catch {
        // Absent status file: the pane died before the wrapper's echo; unknown is not green.
    }
    let logTail = "";
    try {
        logTail = (await readFile(logPath, "utf8")).slice(-LOG_TAIL);
    } catch {
        // No log is a fact the tail just reflects.
    }
    const verdict = await deps.verifyStore.record(dir, exitCode === 0 ? "green" : "red", Date.now());
    if (exitCode === 0) {
        activity(deps, "deps.verify_green", `Checks green for ${whereOf(dir)} (${command}).`, "ok", origin);
    } else {
        activity(
            deps,
            "deps.verify_red",
            `Checks failed for ${whereOf(dir)} (${command}, exit ${exitCode}, attempt ${verdict.attempt}): full output in the ${key} terminal.`,
            "error",
            origin,
        );
    }
    // Emitted only with a cause to name: a chore reads `repos` as a git span to work, which a causeless run lacks.
    if (verdict.edge !== undefined && origin.kind === "land") {
        deps.emit?.({
            event: verdict.edge === "broken" ? "deps.broken" : "deps.fixed",
            agentId: origin.agentId,
            ...(origin.title !== undefined ? { title: origin.title } : {}),
            branch: origin.branch,
            outcome: "landed",
            repos: origin.repos,
            deps: { project: dir, command, exitCode, attempt: verdict.attempt, logTail },
        });
    }
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
    // One check per tree, not per land: a still-pending request for the same dirs is replaced by the newer one.
    const same = pending.findIndex((entry) => entry.dirs.length === wanted.length && entry.dirs.every((dir) => wanted.includes(dir)));
    if (same !== -1) {
        pending.splice(same, 1);
    }
    pending.push({ deps, origin, dirs: wanted });
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
