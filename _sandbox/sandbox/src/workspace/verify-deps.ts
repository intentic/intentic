import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ActivityStore } from "../activity/activity-store.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import { statePath } from "./state-paths.js";
import type { VerifyStore } from "./verify-store.js";
import { installPanelKey, workspaceSetup } from "./workspace-setup.js";

/* THE DEPENDENCY VERIFIER — the deterministic half of "a landed change broke the tree, and somebody should
 * know before they build on it".
 *
 * The reconciler (reconcile-deps.ts) restores the INSTALL after a land drifts it; this runs the tree's own
 * CHECKS once that install is done, remembers the verdict (verify-store.ts), and announces the edges as
 * workspace events (`deps.broken` / `deps.fixed`) that a chore — typically the fix automation — can wake on.
 * Everything it does is watchable: the check runs in a `<project>--verify` terminal panel exactly as the
 * install runs in `<project>--install`, and every verdict lands in the activity feed. The chain's design rule
 * is NO HIDDEN MAGIC: each step leaves a trace the owner can open.
 *
 * WHAT COUNTS AS THE CHECKS. The project's own word for it: a `verify` script first (this repo's convention
 * for "the gate CI decides on"), else `test`. No script ⇒ the project has no checks to run, and the honest
 * answer is an activity entry saying so, not a guessed command. Scripts are a node-manifest concept, so a
 * python project reads as check-less for now — same honest entry.
 *
 * SCHEDULING RULES, inherited from the reconciler and for the same reasons: never while a turn is live (the
 * check reads the very node_modules a turn's overlay has as its lowerdir, and it would race the CPU the
 * owner is watching), defer-and-retry rather than queue, latest cause wins. One chain at a time across the
 * daemon — checks are minutes, and two verifies interleaving their panels would tell the user less than one
 * telling the truth slowly.
 *
 * THE EXIT CODE comes out of the panel by wrapping the command: tmux reports a pane's foreground command,
 * never an exit status, so the wrapped line tees output to a log (for the event's bounded tail) and drops
 * `$pipestatus[1]` into a status file the daemon reads once the sweep sees the shell back at its prompt. The
 * wrapper is zsh syntax on purpose — the panel shell IS zsh (managed-processes' SHELL), the same constant
 * the sweep's prompt detection already pins. A missing or unparseable status file (the owner Ctrl+C'd the
 * pane, the shell died) reads as exit -1: unknown is not green. */

export const verifyPanelKey = (dir: string): string => `${dir === "" ? "root" : dir.replace(/[^a-zA-Z0-9_-]/g, "_")}--verify`;

// How much of the log rides the event. The payload reaches a guard's environment and a prompt, so it is a
// TAIL — the verdict a test runner prints last — and the full log stays one attach away in the panel.
const LOG_TAIL = 2_000;
// Polls of the panel sweep while an install or a check runs. Nothing here is latency-sensitive; the sweep
// itself only samples every 2s.
const POLL_MS = 2_000;
// How long the verifier watches a run before giving up on OBSERVING it (the panel itself is left alone — the
// owner may be watching a legitimately slow suite). Giving up is recorded honestly in the activity feed.
const WATCH_MAX_MS = 30 * 60_000;
// A deferred chain retries on the reconciler's own cadence, and for the same reason: nothing is lost by
// waiting — the verdict is about the tree, and the tree will still be there.
const RETRY_MS = 30_000;

// The land that set this chain off — what the emitted event names as its cause. Threaded through rather than
// re-derived because by the time a check finishes, the fleet has moved: the triggering land is the one fact
// the event must carry that the tree can no longer answer.
export interface LandContext {
    readonly agentId: string;
    readonly title?: string;
    readonly branch: string;
    readonly repos: WorkspaceEvent["repos"];
}

export interface VerifyDeps {
    readonly workspace: { readonly root: string };
    readonly processes: ManagedProcesses;
    readonly agents: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Logger;
    readonly verifyStore: VerifyStore;
    readonly activity: Pick<ActivityStore, "append">;
    // Bound to emitWorkspaceEvent by the land path — an injected sink here so the chain neither needs the
    // whole services object nor a wake fn, and a test reads announcements off an array.
    readonly emit: (event: WorkspaceEvent) => void;
    // Test dials; the daemon takes the defaults.
    readonly pollMs?: number;
    readonly retryMs?: number;
    readonly watchMaxMs?: number;
}

interface PendingVerify {
    readonly deps: VerifyDeps;
    readonly context: LandContext;
    readonly dirs: readonly string[];
}

// One armed retry and one live chain for the whole daemon — the reconciler's shape, chained one stage later.
let retry: ReturnType<typeof setTimeout> | undefined;
let pending: PendingVerify | undefined;
let running = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Wait until `key` stops running, or the watch window closes. True when it stopped.
const watchPanel = async (deps: VerifyDeps, key: string): Promise<boolean> => {
    const deadline = Date.now() + (deps.watchMaxMs ?? WATCH_MAX_MS);
    while (Date.now() < deadline) {
        if (!deps.processes.running(key)) {
            return true;
        }
        await sleep(deps.pollMs ?? POLL_MS);
    }
    return false;
};

const activity = (deps: VerifyDeps, type: string, content: string, outcome: "ok" | "error", context: LandContext): void => {
    void deps.activity
        .append({
            direction: "system",
            type,
            content,
            outcome,
            conversationId: context.agentId,
            ...(context.title !== undefined ? { title: context.title } : {}),
        })
        .catch((error: unknown) => deps.logger.warn({ err: error, type }, "dependency verify: activity append failed"));
};

const whereOf = (dir: string): string => (dir === "" ? "the workspace root" : dir);

// The project's own check command, or undefined when it declares none. Scripts live in package.json; the
// manager comes from the same recipe detection the install used, so `pnpm run verify` and `npm run test`
// come out under the project's own manager.
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

/* Run one project's check to a verdict: panel up, exit code out, store updated, edge announced. The wrapped
 * command is one zsh line; `pipestatus[1]` is the check's own exit, not tee's. */
const verifyProject = async (verify: PendingVerify, dir: string, command: string): Promise<void> => {
    const { deps, context } = verify;
    const key = verifyPanelKey(dir);
    // Under .intentic (the daemon's own state dir, outside every repo) so a running check never dirties the
    // tree it is checking; named through statePath so the state table and this writer cannot drift.
    const artifacts = statePath(deps.workspace.root, ".intentic/verify/");
    const logPath = join(artifacts, `${key}.log`);
    const statusPath = join(artifacts, `${key}.status`);
    await deps.processes.start(key, {
        command: `mkdir -p ${artifacts} && rm -f ${statusPath} && { ${command}; } 2>&1 | tee ${logPath}; echo $pipestatus[1] > ${statusPath}`,
        cwd: join(deps.workspace.root, dir),
        oneShot: true,
    });
    if (!(await watchPanel(deps, key))) {
        activity(
            deps,
            "deps.verify_lost",
            `Checks for ${whereOf(dir)} (${command}) outran the daemon's watch window — verdict not recorded; see the ${key} terminal.`,
            "error",
            context,
        );
        return;
    }
    let exitCode = -1;
    try {
        const status = Number.parseInt((await readFile(statusPath, "utf8")).trim(), 10);
        exitCode = Number.isNaN(status) ? -1 : status;
    } catch {
        // Absent status file: the pane died before the wrapper's echo — unknown is not green.
    }
    let logTail = "";
    try {
        logTail = (await readFile(logPath, "utf8")).slice(-LOG_TAIL);
    } catch {
        // No log is a fact the tail just reflects.
    }
    const verdict = await deps.verifyStore.record(dir, exitCode === 0 ? "green" : "red", Date.now());
    if (exitCode === 0) {
        activity(deps, "deps.verify_green", `Checks green for ${whereOf(dir)} (${command}).`, "ok", context);
    } else {
        activity(
            deps,
            "deps.verify_red",
            `Checks failed for ${whereOf(dir)} (${command}, exit ${exitCode}, attempt ${verdict.attempt}) — full output in the ${key} terminal.`,
            "error",
            context,
        );
    }
    if (verdict.edge !== undefined) {
        deps.emit({
            event: verdict.edge === "broken" ? "deps.broken" : "deps.fixed",
            agentId: context.agentId,
            ...(context.title !== undefined ? { title: context.title } : {}),
            branch: context.branch,
            outcome: "landed",
            repos: context.repos,
            deps: { project: dir, command, exitCode, attempt: verdict.attempt, logTail },
        });
    }
};

/* One pass over the pending request. Installs first: a check against a half-installed tree would report the
 * install's absence as the code's failure, which is the exact misreading this whole chain exists to prevent. */
const runChain = async (verify: PendingVerify): Promise<void> => {
    const { deps, context } = verify;
    for (const dir of verify.dirs) {
        if (deps.processes.running(installPanelKey(dir)) && !(await watchPanel(deps, installPanelKey(dir)))) {
            activity(
                deps,
                "deps.install_lost",
                `Install for ${whereOf(dir)} outran the daemon's watch window — checks not run; see the ${installPanelKey(dir)} terminal.`,
                "error",
                context,
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
            // An install that ran and left the project unready failed; a chore cannot fix a broken install,
            // so this stops at telling the owner rather than waking anyone.
            activity(
                deps,
                "deps.install_failed",
                `Install for ${whereOf(dir)} finished but the project is still ${status.state} — checks not run; see the ${installPanelKey(dir)} terminal.`,
                "error",
                context,
            );
            continue;
        }
        const command = await checkCommandFor(deps.workspace.root, dir, status.recipe.manager);
        if (command === undefined) {
            activity(
                deps,
                "deps.verify_skipped",
                `Dependencies installed for ${whereOf(dir)}, but it defines no verify or test script — nothing to check.`,
                "ok",
                context,
            );
            continue;
        }
        await verifyProject(verify, dir, command);
    }
};

/* Ask for the projects in `dirs` to be checked once their installs settle. The public face of this module:
 * the reconciler's caller queues it as installs start, the land path queues red projects a land touched.
 * Defers while turns are live; the newest cause wins, exactly as the reconciler's own retry does. */
export const queueVerify = (deps: VerifyDeps, context: LandContext, dirs: readonly string[]): void => {
    if (dirs.length === 0) {
        return;
    }
    // Merge into whatever is waiting: two lands in a burst want the union checked, under the newest cause.
    const merged = pending === undefined ? dirs : [...new Set([...pending.dirs, ...dirs])];
    pending = { deps, context, dirs: merged };
    if (retry !== undefined || running) {
        return;
    }
    const attempt = (): void => {
        const next = pending;
        if (next === undefined || running) {
            return;
        }
        if (next.deps.agents.liveSessionIds().length > 0) {
            retry = setTimeout(() => {
                retry = undefined;
                attempt();
            }, next.deps.retryMs ?? RETRY_MS);
            retry.unref();
            return;
        }
        pending = undefined;
        running = true;
        void runChain(next)
            .catch((error: unknown) => next.deps.logger.warn({ err: error }, "dependency verify: chain failed"))
            .finally(() => {
                running = false;
                // Work queued while the chain ran starts its own pass, against the tree as it stands now.
                attempt();
            });
    };
    attempt();
};
