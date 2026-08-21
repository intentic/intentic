import { execFile } from "node:child_process";
import type { AgentTurn } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { steerTurn } from "./agent-steering.js";
import { startConversationTurn } from "./turn-resume.js";

/* "WAKE ME WHEN THE WORLD CHANGES", the daemon-owned condition watch that replaces hand-rolled polling loops.
 *
 * A turn that had to outwait something OUTSIDE the harness, a CI run, a deploy, a remote queue, used to write
 * its own watcher: a backgrounded `while … sleep 30` with a guessed cap and a note to itself to relaunch it,
 * because nothing here would do the waiting for it. Every guess in that loop (the pacing, the 9-minute cap, the
 * relaunch) was the model filling a silence the harness left, and every check burned a pane line to be read
 * back later. This module moves the whole loop to the daemon: the agent states the condition ONCE, a cheap
 * check command that exits 0 when the thing has happened, and the turn ends. The daemon runs the check on its
 * interval, and when it passes (or the deadline arrives, whichever first) the CONVERSATION is woken with the
 * check's own output: steered into a turn that happens to be live, or started as a fresh turn resuming the
 * provider session, through the same door every daemon-started turn uses (turn-resume.ts). Either way the
 * agent is re-invoked exactly once, with the answer in hand.
 *
 * DAEMON-SIDE for the same reason loops/loop-runner.ts is: anything that must survive the turn cannot live in
 * the turn. The CLI subprocess dies when the turn settles, so its own scheduling tools (ScheduleWakeup, the
 * Cron family, disallowed in agent.ts) accept schedules that can never fire here; a tmux loop survives but
 * nothing wakes the agent when it ends. The daemon is the one resident that can both run the check and start
 * the turn that acts on it.
 *
 * BOTH ENDINGS WAKE. A watch that fired says so; a watch that timed out says THAT, with the last check's
 * output, a watcher that goes quiet when its check breaks looks healthy while broken, so silence is never an
 * outcome. Between those two, exactly one wake per watch.
 *
 * IN-MEMORY, LIKE THE LOOPS' `running` MAP. A watch's env snapshot carries capability credentials (the check
 * that asks GitHub needs the token the turn had), and persisting those to disk to survive a daemon restart is
 * a worse trade than losing the watch, the timeout wake is the bounded loss, the credential file is not.
 * Armed watchers DO keep a hosted box alive (system/idle-stop.ts counts them), which is exactly what the noisy
 * tmux loop did by accident: a machine mid-watch is not idle. */

// One check may not run longer than this, a hung curl is a failed check, not a stuck watch.
const CHECK_TIMEOUT_MS = 60_000;
// What a check may say: enough tail to carry a real status blob or error into the wake, small enough that the
// wake prompt stays about acting on the answer.
const OUTPUT_TAIL = 3_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// The pacing bounds. The floor keeps a watch from becoming the busy-loop it replaces; the ceiling keeps "armed"
// meaning "will actually notice".
const MIN_INTERVAL_S = 10;
const MAX_INTERVAL_S = 1_800;
export const DEFAULT_INTERVAL_S = 60;
// The deadline bounds. Every watch has one, because "forever" is the silence this module exists to remove.
const MIN_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 24 * 3_600;
export const DEFAULT_TIMEOUT_S = 2 * 3_600;
// A conversation's watch budget. Eight concurrent outside conditions is a workflow; more is a leak.
export const MAX_PER_CONVERSATION = 8;
/* Delivery retries. A wake can only fail to land while a turn is LIVE on the conversation and unsteerable (a
 * non-steering runtime mid-turn); turns end, so a patient retry converges. Bounded all the same, a report that
 * cannot land inside an hour is logged whole rather than looping forever. */
const DELIVER_RETRY_MS = 15_000;
const DELIVER_ATTEMPTS = 240;

/* The turn identity a wake must reproduce, snapshotted at arm time. `sessionId` is looked up at FIRE time
 * instead (the conversation may advance while the watch runs), but provider/account/model/isolation are the
 * arming turn's own: a session only resumes on the provider that minted it, and an isolated conversation's work
 * sits in a worktree the wake must re-enter. `unattended` carries the posture, a watch armed by an automation
 * must not wake into a turn that can park on a question nobody will answer. */
export interface WatcherTurnSeed {
    readonly agent?: AgentTurn["agent"];
    readonly harness?: AgentTurn["harness"];
    readonly account?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly isolated?: boolean;
    readonly unattended?: boolean;
}

export interface WatcherSpec {
    readonly conversationId: string;
    // Exits 0 when the condition is met, non-zero while still waiting. The agent authors it; the daemon runs it.
    readonly command: string;
    // The agent's one line on what it is waiting for, shown in the wake and in logs.
    readonly note: string;
    readonly intervalSeconds?: number;
    readonly timeoutSeconds?: number;
    // Where and with what the check runs: the turn's effective tree and its capability credentials.
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly turn: WatcherTurnSeed;
}

export interface CheckResult {
    // Undefined when the check did not exit on its own (killed at CHECK_TIMEOUT_MS, or failed to spawn).
    readonly exitCode: number | undefined;
    readonly output: string;
}

interface WatcherRecord {
    readonly id: string;
    readonly spec: WatcherSpec;
    readonly intervalMs: number;
    readonly armedAt: number;
    readonly deadlineAt: number;
    checks: number;
    last: CheckResult;
    timer: NodeJS.Timeout | undefined;
    // A record leaves the map the moment it stops checking; this flag only guards the in-flight check.
    cancelled: boolean;
}

export interface WatcherSummary {
    readonly id: string;
    readonly note: string;
    readonly command: string;
    readonly intervalSeconds: number;
    readonly checks: number;
    readonly secondsLeft: number;
}

export type RunCheck = (command: string, options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => Promise<CheckResult>;

/* The real check: one bash invocation, stdout+stderr folded together (an error's text is usually on stderr and
 * is exactly what the wake needs to show), tail-capped, killed at the timeout. A spawn failure or kill answers
 * exitCode undefined, "still waiting" to the loop, and visibly not-zero in the report. */
const bashCheck: RunCheck = (command, options) =>
    new Promise((resolve) => {
        execFile(
            "bash",
            ["-lc", command],
            { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
            (error, stdout, stderr) => {
                const output = `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.trim().slice(-OUTPUT_TAIL);
                const code =
                    error === null
                        ? 0
                        : typeof (error as { code?: unknown }).code === "number"
                          ? ((error as { code: number }).code as number)
                          : undefined;
                resolve({ exitCode: code, output });
            },
        );
    });

/* The runtime seam, configured once at boot (main.ts), injected rather than imported because the arm side of
 * this module is reached from turn-plan, and importing agent.routes from under turn-plan closes a cycle. The
 * two delivery primitives are the seam tests stand fakes into: `steer` lands the report in a live turn,
 * `start` opens the wake turn and answers false when a live turn holds the conversation. */
export interface WatcherRuntime {
    readonly logger: Logger;
    readonly runCheck: RunCheck;
    readonly steer: (conversationId: string, text: string) => boolean;
    readonly start: (turn: AgentTurn & { conversationId: string }) => Promise<boolean>;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
}

let runtime: WatcherRuntime | undefined;
const records = new Map<string, WatcherRecord>();
let sequence = 0;

// Idle-stop's probe: a machine mid-watch is not idle, stopping it is how a watch silently never fires.
export const armedWatcherCount = (): number => records.size;

export const listWatchers = (conversationId: string): WatcherSummary[] =>
    [...records.values()]
        .filter((record) => record.spec.conversationId === conversationId)
        .map((record) => ({
            id: record.id,
            note: record.spec.note,
            command: record.spec.command,
            intervalSeconds: Math.round(record.intervalMs / 1000),
            checks: record.checks,
            secondsLeft: Math.max(0, Math.round((record.deadlineAt - Date.now()) / 1000)),
        }));

// Only a conversation's own watches answer to it, the same scoping rule subagent-wait holds.
export const cancelWatcher = (conversationId: string, id: string): boolean => {
    const record = records.get(id);
    if (record === undefined || record.spec.conversationId !== conversationId) {
        return false;
    }
    discard(record);
    return true;
};

const discard = (record: WatcherRecord): void => {
    record.cancelled = true;
    if (record.timer !== undefined) {
        clearTimeout(record.timer);
        record.timer = undefined;
    }
    records.delete(record.id);
};

const elapsed = (record: WatcherRecord): string => {
    const seconds = Math.round((Date.now() - record.armedAt) / 1000);
    return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

/* The wake's whole prompt. Written to be acted on, not admired: what was being watched, how it ended, and the
 * check's own last words, then one sentence telling the model this is the continuation it asked for. A timeout
 * says so in the first line, because "the condition never came" is a different next step than "it fired". */
const report = (record: WatcherRecord, outcome: "met" | "timeout"): string => {
    const head =
        outcome === "met"
            ? `The condition you were watching is now met (check #${record.checks}, ${elapsed(record)} after arming).`
            : `The watch timed out after ${elapsed(record)} without the condition being met, the check never exited 0. Decide whether to re-arm it, investigate the check, or report back.`;
    const exit = record.last.exitCode === undefined ? "none (check was killed or failed to start)" : String(record.last.exitCode);
    return [
        `[watch ${record.id}] ${head}`,
        `Watching: ${record.spec.note}`,
        `Check command: ${record.spec.command}`,
        `Last exit code: ${exit}`,
        ...(record.last.output === "" ? [] : ["Last output (tail):", "```", record.last.output, "```"]),
        "Continue the task this watch was armed for.",
    ].join("\n");
};

/* Land the report. A live turn takes it as a steer (delivered between tool calls, like a user message); with no
 * turn live, a fresh one starts on the conversation, resuming its CURRENT provider session so the agent picks
 * the thread back up rather than meeting the task again. startConversationTurn answering undefined means a turn
 * is live but unsteerable, wait for it to end and try again. */
const deliver = async (live: WatcherRuntime, record: WatcherRecord, outcome: "met" | "timeout"): Promise<void> => {
    const { conversationId } = record.spec;
    const message = report(record, outcome);
    for (let attempt = 0; attempt < DELIVER_ATTEMPTS; attempt += 1) {
        if (live.steer(conversationId, message)) {
            live.logger.info({ watch: record.id, conversationId, outcome }, "watch: report steered into the live turn");
            return;
        }
        const seed = record.spec.turn;
        const sessionId = live.sessionIdOf(conversationId);
        try {
            const started = await live.start({
                prompt: message,
                conversationId,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(seed.agent !== undefined ? { agent: seed.agent } : {}),
                ...(seed.harness !== undefined ? { harness: seed.harness } : {}),
                ...(seed.account !== undefined ? { account: seed.account } : {}),
                ...(seed.model !== undefined ? { model: seed.model } : {}),
                ...(seed.effort !== undefined ? { effort: seed.effort } : {}),
                ...(seed.isolated === true ? { isolated: true } : {}),
                ...(seed.unattended === true ? { unattended: true } : {}),
            });
            if (started) {
                live.logger.info({ watch: record.id, conversationId, outcome }, "watch: wake turn started");
                return;
            }
        } catch (error) {
            live.logger.warn({ err: error, watch: record.id, conversationId }, "watch: wake turn failed to start, retrying");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, DELIVER_RETRY_MS).unref());
    }
    // The bounded loss, said whole: the report goes into the log rather than nowhere.
    live.logger.error({ watch: record.id, conversationId, report: message }, "watch: report could not be delivered");
};

const fire = (live: WatcherRuntime, record: WatcherRecord, outcome: "met" | "timeout"): void => {
    discard(record);
    void deliver(live, record, outcome).catch((error: unknown) => live.logger.error({ err: error, watch: record.id }, "watch: delivery crashed"));
};

// One check, then the verdict: fire on 0, fire on the deadline, otherwise sleep an interval and go again. The
// next check is scheduled AFTER this one completes, so a slow check can never overlap itself.
const tick = async (live: WatcherRuntime, record: WatcherRecord): Promise<void> => {
    record.checks += 1;
    record.last = await live.runCheck(record.spec.command, { cwd: record.spec.cwd, env: record.spec.env });
    if (record.cancelled) {
        return;
    }
    if (record.last.exitCode === 0) {
        fire(live, record, "met");
        return;
    }
    if (Date.now() >= record.deadlineAt) {
        fire(live, record, "timeout");
        return;
    }
    schedule(live, record);
};

const schedule = (live: WatcherRuntime, record: WatcherRecord): void => {
    // Never past the deadline: a 30-minute interval on a watch with 40 seconds left checks once more at the
    // deadline instead of sleeping through it.
    const wait = Math.min(record.intervalMs, Math.max(0, record.deadlineAt - Date.now()));
    record.timer = setTimeout(() => {
        record.timer = undefined;
        void tick(live, record).catch((error: unknown) => {
            live.logger.error({ err: error, watch: record.id }, "watch: check crashed, watch dropped");
            discard(record);
        });
    }, wait);
    // A watchdog must never hold the event loop open on its own (idle-stop's rule, same reason).
    record.timer.unref();
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export type ArmOutcome =
    // The condition already held when asked, nothing armed, no wake coming.
    | { readonly kind: "already-met"; readonly firstCheck: CheckResult }
    | {
          readonly kind: "armed";
          readonly id: string;
          readonly intervalSeconds: number;
          readonly timeoutSeconds: number;
          readonly firstCheck: CheckResult;
      }
    | { readonly kind: "refused"; readonly reason: string };

/* Arm a watch. The first check runs NOW, inside this call: a broken check command (typo, missing token, wrong
 * URL) answers to the agent's face instead of reading as "still waiting" for two silent hours, the trap the
 * reference designs all warn about. Exit 0 on the first check arms nothing at all. */
export const armWatcher = async (spec: WatcherSpec): Promise<ArmOutcome> => {
    const live = runtime;
    if (live === undefined) {
        return { kind: "refused", reason: "Watching is not available in this runtime." };
    }
    if (listWatchers(spec.conversationId).length >= MAX_PER_CONVERSATION) {
        return { kind: "refused", reason: `This conversation already has ${MAX_PER_CONVERSATION} armed watches, stop one first.` };
    }
    const firstCheck = await live.runCheck(spec.command, { cwd: spec.cwd, env: spec.env });
    if (firstCheck.exitCode === 0) {
        return { kind: "already-met", firstCheck };
    }
    const intervalSeconds = clamp(Math.round(spec.intervalSeconds ?? DEFAULT_INTERVAL_S), MIN_INTERVAL_S, MAX_INTERVAL_S);
    const timeoutSeconds = clamp(Math.round(spec.timeoutSeconds ?? DEFAULT_TIMEOUT_S), MIN_TIMEOUT_S, MAX_TIMEOUT_S);
    const now = Date.now();
    sequence += 1;
    const record: WatcherRecord = {
        id: `watch-${sequence}`,
        spec,
        intervalMs: intervalSeconds * 1000,
        armedAt: now,
        deadlineAt: now + timeoutSeconds * 1000,
        checks: 1,
        last: firstCheck,
        timer: undefined,
        cancelled: false,
    };
    records.set(record.id, record);
    schedule(live, record);
    live.logger.info({ watch: record.id, conversationId: spec.conversationId, intervalSeconds, timeoutSeconds, note: spec.note }, "watch: armed");
    return { kind: "armed", id: record.id, intervalSeconds, timeoutSeconds, firstCheck };
};

/* The runtime with the seams bound, exported for the tests, which stand fakes into every slot. The returned
 * stop drops every armed watch: a daemon on its way down cannot check anything, and the record honestly gone
 * beats a timer into a dead process. */
export const startWatcherRuntime = (live: WatcherRuntime): (() => void) => {
    runtime = live;
    return () => {
        // Deleting the entry being visited is safe under Map iteration.
        for (const record of records.values()) {
            discard(record);
        }
        runtime = undefined;
    };
};

// Boot wiring (main.ts): the real check under bash, the real steering registry, and the same detached-turn
// door every daemon-started turn uses (turn-resume.ts), which journals the wake, so even a daemon death
// between start and first frame re-runs it.
export const startWatchers = (services: Services, wake: WakeFn): (() => void) =>
    startWatcherRuntime({
        logger: services.logger,
        runCheck: bashCheck,
        steer: steerTurn,
        start: async (turn) => (await startConversationTurn(services, wake, turn)) !== undefined,
        sessionIdOf: (conversationId) => services.agents.sessionIdOf(conversationId),
    });
