import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import type { AgentTurn } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { WakeFn } from "../../automations/scheduler.js";
import { turnCliEnv } from "../../capabilities/turn-env.js";
import type { Services } from "../../composition.js";
import { steerTurn } from "../anchors/agent-steering.js";
import { startConversationTurn } from "../run/turn/turn-resume.js";
import { seedFields, type TurnSeed } from "../run/turn/turn-seed.js";
import type { JournalledWatch, WatchJournal } from "./watch-journal.js";
import { watchProjection } from "./watch-state.js";

// Daemon-owned condition watch replacing hand-rolled `while ... sleep` polling loops: the agent states a check once,
// the daemon runs it on an interval, since nothing here can outlive the turn's own subprocess, and wakes the
// conversation exactly once, fired or timed out, never silently. Live in memory for checking, armed on disk so a
// container recreate, ordinary here, can restore it; only the check's env var names are persisted, values come fresh
// from the capability store.

// One check may not run longer than this, a hung curl is a failed check, not a stuck watch.
const CHECK_TIMEOUT_MS = 60_000;
// What a check may say: enough tail for a real status or error, small enough to keep the wake acting on it.
const OUTPUT_TAIL = 3_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// Pacing bounds: the floor keeps a watch from being the busy-loop it replaces; the ceiling keeps it noticing.
const MIN_INTERVAL_S = 10;
const MAX_INTERVAL_S = 1_800;
export const DEFAULT_INTERVAL_S = 60;
// The deadline bounds. Every watch has one, because "forever" is the silence this module exists to remove.
const MIN_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 24 * 3_600;
export const DEFAULT_TIMEOUT_S = 2 * 3_600;
// A conversation's watch budget: eight concurrent outside conditions is a workflow, more is a leak.
export const MAX_PER_CONVERSATION = 8;
// Delivery retries: a wake fails to land only while live and unsteerable, and turns end, so it converges.
const DELIVER_RETRY_MS = 15_000;
const DELIVER_ATTEMPTS = 240;

/* The turn identity a wake must reproduce, snapshotted at arm time, and shared with the proof follow-up because
 * the two continue a turn for the same reason (agent/run/turn/turn-seed.ts has the argument, and the list).
 * `sessionId` is deliberately not in it: that is looked up at FIRE time, since the conversation may advance
 * while the watch runs. Everything else is the arming turn's own — a session only resumes on the provider that
 * minted it, an isolated conversation's work sits in a worktree the wake must re-enter, and `unattended` carries
 * the posture, since a watch armed by an automation must not wake into a turn that can park on a question nobody
 * will answer. */
export type WatcherTurnSeed = TurnSeed;

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

// The real check: one bash invocation, stdout and stderr folded together, tail-capped, killed at the timeout. A spawn
// failure or kill answers undefined exit code, read as still-waiting by the loop and visibly non-zero in the report.
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

// The runtime seam, configured once at boot and injected rather than imported, since importing agent.routes from under
// turn-plan would close a cycle. `steer` lands the report in a live turn; `start` opens the wake turn.
export interface WatcherRuntime {
    readonly logger: Logger;
    readonly runCheck: RunCheck;
    readonly steer: (conversationId: string, text: string) => boolean;
    readonly start: (turn: AgentTurn & { conversationId: string }) => Promise<boolean>;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
    // What an armed watch IS, on disk, so a daemon that dies under one can put it back (watch-journal.ts).
    readonly journal: WatchJournal;
    // The environment a check runs with today, asked at restore time, not off disk, so no credential is persisted.
    readonly envOf: () => Promise<Record<string, string>>;
    // Whether a journalled watch's conversation exists, unarchived; outliving it is a timer nothing answers to.
    readonly conversationLive: (conversationId: string) => boolean;
    // Whether a journalled watch's tree is still on disk; a removed worktree means dropping it, not re-running.
    readonly treeLive: (cwd: string) => Promise<boolean>;
}

let runtime: WatcherRuntime | undefined;
const records = new Map<string, WatcherRecord>();
let sequence = 0;

// The next free `watch-N`: the counter resets every boot while restored watches keep their armed ids, so a fresh id
// must skip what a restore already claimed. Ids stay short since the agent types them back (`watch stop watch-3`).
const nextId = (): string => {
    do {
        sequence += 1;
    } while (records.has(`watch-${sequence}`));
    return `watch-${sequence}`;
};

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
export const cancelWatcher = async (conversationId: string, id: string): Promise<boolean> => {
    const record = records.get(id);
    if (record === undefined || record.spec.conversationId !== conversationId) {
        return false;
    }
    await discard(record);
    return true;
};

// The user's own disarm-the-lot, reachable without a running turn (unlike the agent's `watch stop`); walks the same
// `discard` every ending uses, and answers how many it took.
export const cancelWatchersFor = async (conversationId: string): Promise<number> => {
    // Snapshotted before the loop: `discard` deletes from the map being iterated.
    const own = [...records.values()].filter((record) => record.spec.conversationId === conversationId);
    for (const record of own) {
        await discard(record);
    }
    return own.length;
};

// Stop checking, the in-memory half only, and the only half a daemon on its way down performs; `discard` also drops the
// journal entry, and a shutdown that did that too would disarm exactly the watches this exists to bring back.
const forget = (record: WatcherRecord): void => {
    record.cancelled = true;
    if (record.timer !== undefined) {
        clearTimeout(record.timer);
        record.timer = undefined;
    }
    records.delete(record.id);
    publish(record.spec.conversationId);
};

// The watch is over: fired, timed out, or stopped by the agent or the user. The journal drop is awaited by every
// caller, since a stop and a recreate must not resurrect a dismissed watch; a drop that finds no file is a no-op.
const discard = async (record: WatcherRecord): Promise<void> => {
    forget(record);
    await runtime?.journal.drop(record.id).catch((error: unknown) => {
        runtime?.logger.error({ err: error, watch: record.id }, "watch: journal entry could not be dropped, a restart may re-arm it");
    });
};

// Tells the fleet card what the conversation is parked on, on every transition, nowhere else; a tick publishes nothing.
// The empty array publishes like any value, letting the registry turn it back into absence.
const publish = (conversationId: string): void =>
    watchProjection.set(
        conversationId,
        [...records.values()]
            .filter((record) => record.spec.conversationId === conversationId)
            .map((record) => ({
                id: record.id,
                note: record.spec.note,
                intervalSeconds: Math.round(record.intervalMs / 1000),
                deadlineAt: record.deadlineAt,
            })),
    );

// Three endings that wake: `met` and `timeout` are promised at arm time; `restart-expired` is the world's own, a
// deadline that passed while the daemon was down, evidence about us rather than about the world.
type WatchOutcome = "met" | "timeout" | "restart-expired";

const elapsed = (record: WatcherRecord): string => {
    const seconds = Math.round((Date.now() - record.armedAt) / 1000);
    return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

// The wake's whole prompt: what was watched, how it ended, the check's last words, and one sentence saying this
// continues the turn. A timeout says so first, since it calls for a different next step than a met condition.
const report = (record: WatcherRecord, outcome: WatchOutcome): string => {
    const head =
        outcome === "met"
            ? `The condition you were watching is now met (${elapsed(record)} after arming).`
            : outcome === "timeout"
              ? `The watch timed out after ${elapsed(record)} without the condition being met, the check never exited 0. Decide whether to re-arm it, investigate the check, or report back.`
              : /* The restart ending, said as itself rather than dressed up as a timeout: the deadline passed while
                 * the daemon was down, so the check did NOT run for part of that window and "it never happened" is
                 * more than this watch actually knows. The one thing it does know is that the condition does not
                 * hold now, because restore re-checks before it says any of this. */
                `The watch was armed ${elapsed(record)} ago and its deadline passed while the daemon was restarting, so it stopped being checked partway through. It has just been re-checked once and the condition still does not hold. Decide whether to re-arm it, investigate the check, or report back.`;
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

// Lands the report: a live turn takes it as a steer, otherwise a fresh turn resumes the current provider session.
// `start` answering undefined means a turn is live but unsteerable; wait and retry.
const deliver = async (live: WatcherRuntime, record: WatcherRecord, outcome: WatchOutcome): Promise<void> => {
    const { conversationId } = record.spec;
    const message = report(record, outcome);
    for (let attempt = 0; attempt < DELIVER_ATTEMPTS; attempt += 1) {
        if (live.steer(conversationId, message)) {
            live.logger.info({ watch: record.id, conversationId, outcome }, "watch: report steered into the live turn");
            return;
        }
        const sessionId = live.sessionIdOf(conversationId);
        try {
            const started = await live.start({
                prompt: message,
                conversationId,
                ...(sessionId !== undefined ? { sessionId } : {}),
                // The arming turn, whole: same provider, model, knobs, persona, job; a wake continues that turn, not a
                // new one.
                ...seedFields(record.spec.turn),
            });
            if (started) {
                live.logger.info({ watch: record.id, conversationId, outcome }, "watch: wake turn started");
                return;
            }
        } catch (error) {
            live.logger.warn({ err: error, watch: record.id, conversationId }, "watch: wake turn failed to start, retrying");
        }
        await sleep(DELIVER_RETRY_MS, { unref: true });
    }
    // The bounded loss, said whole: the report goes into the log rather than nowhere.
    live.logger.error({ watch: record.id, conversationId, report: message }, "watch: report could not be delivered");
};

// Ends the watch, then says so, strictly in that order: delivery has its own durability, but a crash between a
// delivered report and an undropped journal entry would re-arm and wake the agent twice.
const fire = (live: WatcherRuntime, record: WatcherRecord, outcome: WatchOutcome): void => {
    void discard(record)
        .then(() => deliver(live, record, outcome))
        .catch((error: unknown) => live.logger.error({ err: error, watch: record.id }, "watch: delivery crashed"));
};

// One check, then the verdict: fire on 0, fire on the deadline, else sleep and go again; the next check is scheduled
// only once this one finishes.
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
    // Never past the deadline: a long interval with little time left checks once more, not sleeping through it.
    const wait = Math.min(record.intervalMs, Math.max(0, record.deadlineAt - Date.now()));
    record.timer = setTimeout(() => {
        record.timer = undefined;
        void tick(live, record).catch((error: unknown) => {
            live.logger.error({ err: error, watch: record.id }, "watch: check crashed, watch dropped");
            // Off disk too: a check that crashes the runner is not a watch a restart should faithfully re-arm.
            void discard(record);
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

// Arms a watch; the first check runs now, inside this call, so a broken command fails to the agent's face instead of
// reading as still-waiting for hours. Exit 0 on the first check arms nothing.
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
    const record: WatcherRecord = {
        id: nextId(),
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
    // Written before the first timer, so a crash leaves an armed watch restorable, never an orphan timer.
    await live.journal.record({
        id: record.id,
        conversationId: spec.conversationId,
        command: spec.command,
        note: spec.note,
        intervalMs: record.intervalMs,
        armedAt: record.armedAt,
        deadlineAt: record.deadlineAt,
        cwd: spec.cwd,
        // Names, never values: the environment's shape restores, its substance is asked of the capability store again.
        envKeys: Object.keys(spec.env),
        turn: spec.turn,
    });
    schedule(live, record);
    // The card learns in the same breath the map does: this is the moment the conversation stops looking finished.
    publish(spec.conversationId);
    live.logger.info({ watch: record.id, conversationId: spec.conversationId, intervalSeconds, timeoutSeconds, note: spec.note }, "watch: armed");
    return { kind: "armed", id: record.id, intervalSeconds, timeoutSeconds, firstCheck };
};

// Puts back what the daemon died under, once at boot: the journal holds exactly what was armed when the predecessor
// stopped, since every decided ending drops its entry. Every entry is re-checked first, since the condition can resolve
// mid-restart.
export const restoreWatchers = async (): Promise<void> => {
    const live = runtime;
    if (live === undefined) {
        return;
    }
    const entries = await live.journal.list();
    if (entries.length === 0) {
        return;
    }
    // Asked once for the whole pass, not per entry: every watch restoring here wants the same answer.
    const env = await live.envOf();
    for (const entry of entries) {
        try {
            await restoreOne(live, entry, env);
        } catch (error) {
            live.logger.error({ err: error, watch: entry.id, conversationId: entry.conversationId }, "watch: could not be restored, dropping it");
            await live.journal.drop(entry.id);
        }
    }
};

// The journalled seed as the wake wants it: zod's `| undefined` differs from an absent field under
// exactOptionalPropertyTypes, and spreading `account: undefined` would name an account rather than leave it unset. Same
// absent-means-absent rebuild delivery uses.
const seedOf = (turn: JournalledWatch["turn"]): WatcherTurnSeed => seedFields(turn);

const restoreOne = async (live: WatcherRuntime, entry: JournalledWatch, env: Record<string, string>): Promise<void> => {
    const context = { watch: entry.id, conversationId: entry.conversationId, note: entry.note };
    // Two ways a watch is stale, not interrupted: nobody left to wake, or nowhere to run the check.
    if (!live.conversationLive(entry.conversationId)) {
        live.logger.info(context, "watch: not restored, its conversation is gone");
        await live.journal.drop(entry.id);
        return;
    }
    if (!(await live.treeLive(entry.cwd))) {
        live.logger.info({ ...context, cwd: entry.cwd }, "watch: not restored, the tree it checked in is gone");
        await live.journal.drop(entry.id);
        return;
    }
    // Rebuilt, not restored: fresh store values, narrowed to the arming keys, reproduce withholding for free.
    const armedEnv = Object.fromEntries(entry.envKeys.filter((key) => env[key] !== undefined).map((key) => [key, env[key] as string]));
    const check = await live.runCheck(entry.command, { cwd: entry.cwd, env: armedEnv });
    const record: WatcherRecord = {
        id: entry.id,
        spec: {
            conversationId: entry.conversationId,
            command: entry.command,
            note: entry.note,
            cwd: entry.cwd,
            env: armedEnv,
            turn: seedOf(entry.turn),
        },
        intervalMs: entry.intervalMs,
        // The original arm time, so the wake reports real wait time, not time since the daemon came back.
        armedAt: entry.armedAt,
        deadlineAt: entry.deadlineAt,
        checks: 1,
        last: check,
        timer: undefined,
        cancelled: false,
    };
    // Held so `fire`'s discard has something to take off the card, and so the id is taken before nextId runs.
    records.set(record.id, record);
    if (check.exitCode === 0) {
        live.logger.info(context, "watch: condition was met while the daemon was down, waking now");
        fire(live, record, "met");
        return;
    }
    if (Date.now() >= entry.deadlineAt) {
        live.logger.info(context, "watch: deadline passed while the daemon was down, waking with the restart ending");
        fire(live, record, "restart-expired");
        return;
    }
    schedule(live, record);
    // The card gets its readout back: a conversation waiting before the restart must not read as finished after it.
    publish(entry.conversationId);
    live.logger.info({ ...context, secondsLeft: Math.round((entry.deadlineAt - Date.now()) / 1000) }, "watch: re-armed after restart");
};

// The runtime with its seams bound, exported so tests can stand fakes into every slot. The returned stop clears every
// timer and leaves journal entries alone (`forget`, not `discard`): what a dying daemon was checking is exactly what
// the next one must pick up.
export const startWatcherRuntime = (live: WatcherRuntime): (() => void) => {
    runtime = live;
    return () => {
        // Deleting the entry being visited is safe under Map iteration.
        for (const record of records.values()) {
            forget(record);
        }
        runtime = undefined;
    };
};

// Boot wiring: the real check under bash, the real steering registry, and the same detached-turn door every
// daemon-started turn uses, which journals the wake so a daemon death between start and first frame re-runs it.
export const startWatchers = (services: Services, wake: WakeFn): (() => void) =>
    startWatcherRuntime({
        logger: services.logger,
        runCheck: bashCheck,
        steer: steerTurn,
        start: async (turn) => (await startConversationTurn(services, wake, turn)) !== undefined,
        sessionIdOf: (conversationId) => services.agents.sessionIdOf(conversationId),
        journal: services.watchJournal,
        // The same function that builds a turn's shell env, so a restored check can't drift from an arming turn's.
        envOf: () => turnCliEnv(services),
        // Archived counts as live: archiving takes a card off the board without disarming anything.
        conversationLive: (conversationId) => services.agents.entry(conversationId) !== undefined,
        // The real disk, and the only place here that touches it: a landed worktree is gone by the next boot.
        treeLive: (cwd) =>
            access(cwd).then(
                () => true,
                () => false,
            ),
    });
