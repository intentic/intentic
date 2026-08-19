import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ActivityStore } from "../activity/activity-store.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import type { DependencyOrigin } from "./dependency-origin.js";
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
 * Which is why it also runs for the installs the reconciler starts BY ITSELF, off a pull or a hand-edited
 * manifest rather than off a land. A land announces itself in the conversation that caused it — a line in the
 * transcript and a button onto the terminal; a pull announces itself nowhere, so without this chain the whole
 * visible trace of a background install would be a terminal row appearing in a list. Those runs have no cause to
 * attribute, which changes exactly one thing: they record and they do not wake.
 *
 * WHAT COUNTS AS THE CHECKS. The project's own word for it: a `verify` script first (this repo's convention
 * for "the gate CI decides on"), else `test`. No script ⇒ the project has no checks to run, and the honest
 * answer is an activity entry saying so, not a guessed command. Scripts are a node-manifest concept, so a
 * python project reads as check-less for now — same honest entry.
 *
 * SCHEDULING RULES: verification holds nothing back. It waits for the install that prompted it and then runs
 * beside whatever else the workspace is doing — a turn started mid-check can at worst stale an advisory
 * verdict, which costs a re-run, where making anyone wait on a test suite they never asked for costs minutes
 * of their own work. Origins stay attached to their own batches. One chain runs at a time across the daemon,
 * so panels and Activity tell one ordered story.
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
// How long the verifier watches a run before stopping it. A check that never ends would hold the chain — and
// every later verdict — forever, so a timeout is visible in Activity and terminal output, then ends.
const WATCH_MAX_MS = 30 * 60_000;

export interface VerifyDeps {
    readonly workspace: { readonly root: string };
    readonly processes: ManagedProcesses;
    readonly logger: Logger;
    readonly verifyStore: VerifyStore;
    readonly activity: Pick<ActivityStore, "append">;
    /* Bound to emitWorkspaceEvent by the land path — an injected sink here so the chain neither needs the whole
     * services object nor a wake fn, and a test reads announcements off an array.
     *
     * Optional because a chain with no cause provably never reaches it (see verifyProject): the reconciler's own
     * installs have no land to name, so the caller that starts them has no wake to bind and is not asked for one. */
    readonly emit?: (event: WorkspaceEvent) => void;
    // Test dials; the daemon takes the defaults.
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

// A causeless run files under no conversation, which the feed already has a shape for — both fields are
// optional on an activity row, and a row with neither reads as the daemon acting on its own, which is what
// happened. Filing it under an unrelated conversation to avoid an empty column would be worse than a blank.
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
    const { deps, origin } = verify;
    const key = verifyPanelKey(dir);
    // Under .intentic (the daemon's own state dir, outside every repo) so a running check never dirties the
    // tree it is checking; named through statePath so the state table and this writer cannot drift.
    const artifacts = statePath(deps.workspace.root, ".intentic/local/verify/");
    const logPath = join(artifacts, `${key}.log`);
    const statusPath = join(artifacts, `${key}.status`);
    await deps.processes.start(key, {
        command: `mkdir -p ${artifacts} && rm -f ${statusPath} && { ${command}; } 2>&1 | tee ${logPath}; echo $pipestatus[1] > ${statusPath}`,
        cwd: join(deps.workspace.root, dir),
        oneShot: true,
    });
    if (!(await watchPanel(deps, key))) {
        await deps.processes.stop(key);
        activity(
            deps,
            "deps.verify_lost",
            `Checks for ${whereOf(dir)} (${command}) outran the daemon's watch window — verdict not recorded; see the ${key} terminal.`,
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
        activity(deps, "deps.verify_green", `Checks green for ${whereOf(dir)} (${command}).`, "ok", origin);
    } else {
        activity(
            deps,
            "deps.verify_red",
            `Checks failed for ${whereOf(dir)} (${command}, exit ${exitCode}, attempt ${verdict.attempt}) — full output in the ${key} terminal.`,
            "error",
            origin,
        );
    }
    /* The EDGE is announced only when something can be pointed at as its cause. A wake payload is not a
     * notification — a chore reads `repos` as a git span and works the change it names — so a causeless run has
     * nothing to hand one, and an empty span sends the fix automation to look at a diff that does not exist.
     * The verdict is still recorded and still visible in Activity; what a background install cannot do is start
     * somebody else's work on a premise it made up. */
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

/* One pass over the pending request. Installs first: a check against a half-installed tree would report the
 * install's absence as the code's failure, which is the exact misreading this whole chain exists to prevent. */
const runChain = async (verify: PendingVerify): Promise<void> => {
    const { deps, origin } = verify;
    for (const dir of verify.dirs) {
        if (deps.processes.running(installPanelKey(dir)) && !(await watchPanel(deps, installPanelKey(dir)))) {
            await deps.processes.stop(installPanelKey(dir));
            activity(
                deps,
                "deps.install_lost",
                `Install for ${whereOf(dir)} outran the daemon's watch window — checks not run; see the ${installPanelKey(dir)} terminal.`,
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
            // An install that ran and left the project unready failed; a chore cannot fix a broken install,
            // so this stops at telling the owner rather than waking anyone.
            activity(
                deps,
                "deps.install_failed",
                `Install for ${whereOf(dir)} finished but the project is still ${status.state} — checks not run; see the ${installPanelKey(dir)} terminal.`,
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
                `Dependencies installed for ${whereOf(dir)}, but it defines no verify or test script — nothing to check.`,
                "ok",
                origin,
            );
            continue;
        }
        await verifyProject(verify, dir, command);
    }
};

/* Verification queues behind the install that prompted it and never holds a turn out. Origins stay attached to
 * their own batches instead of a process-wide "latest cause wins" slot: a watcher observation can no longer
 * erase a land and prevent its failed check waking the fix automation. */
export const queueVerify = (deps: VerifyDeps, origin: DependencyOrigin, dirs: readonly string[]): void => {
    if (dirs.length === 0) {
        return;
    }
    pending.push({ deps, origin, dirs: [...new Set(dirs)] });
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
