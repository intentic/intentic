import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import type { AgentTurn } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { WakeFn } from "../automations/scheduler.js";
import { turnCliEnv } from "../capabilities/turn-env.js";
import type { Services } from "../composition.js";
import { steerTurn } from "./agent-steering.js";
import { startConversationTurn } from "./turn-resume.js";
import type { JournalledWatch, WatchJournal } from "./watch-journal.js";
import { watchProjection } from "./watch-state.js";

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
 * LIVE IN MEMORY, ARMED ON DISK. The `records` map below is the only thing that checks anything; beside it,
 * watch-journal.ts writes down what each armed watch IS, so a daemon that dies under one can put it back. The
 * split exists because a restart is not an edge case here but the ordinary one: a watch's whole life happens
 * between turns, and intentic recreates its own container on every update, every environment approval and
 * every `dev-sandbox.sh` swap. Held only in memory, that death was the third ending this module says cannot
 * exist, silent: nothing fired, and the deadline that owed the timeout wake died in the same record, so
 * "the timeout wake is the bounded loss" was not true, the loss was total. What the journal deliberately does
 * NOT hold is the check's environment, which is the turn's capability credentials; it keeps the variable
 * NAMES and takes fresh values from the capability store at boot (see watch-journal.ts), so nothing
 * perishable is snapshotted, the same contract agent/turn-journal.ts keeps for turns.
 *
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
    // What an armed watch IS, on disk, so a daemon that dies under one can put it back (watch-journal.ts).
    readonly journal: WatchJournal;
    /* The environment a turn's check would run with TODAY, asked at restore rather than read off disk, so no
     * credential is ever persisted. Narrowed to the arming turn's own key set by the restore, see below. */
    readonly envOf: () => Promise<Record<string, string>>;
    /* Whether the conversation a journalled watch would wake still exists and is not archived. A watch that
     * outlives its conversation is not a stale readout, it is a timer that will eventually try to start a turn
     * on an id nothing answers to, the same thing agents.routes disarms against on discard and purge. */
    readonly conversationLive: (conversationId: string) => boolean;
}

let runtime: WatcherRuntime | undefined;
const records = new Map<string, WatcherRecord>();
let sequence = 0;

/* The next free `watch-N`. A plain counter was enough while the map was the only record of anything, and is
 * not now: the counter resets to zero on every boot while restored watches keep the ids they were armed
 * under, so `watch-1` can already be taken before this process arms its first. The ids stay short because the
 * agent types them back at us (`watch stop watch-3`), so the fix is to skip what is taken rather than to make
 * them unguessable. */
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

/* DISARM THE LOT, the user's own way out (agents.stopWatching), and the only one that exists off the agent's
 * `watch stop`, which needs a turn to be running before it can be reached.
 *
 * It is here rather than in the route because the records map is here: everything that ends a watch has to walk
 * the same `discard`, which is what clears the timer and republishes the card. Answers how many it took, so the
 * caller can tell "disarmed three" from "there was nothing armed" without reading the map itself. */
export const cancelWatchersFor = async (conversationId: string): Promise<number> => {
    // Snapshotted before the loop: `discard` deletes from the map being iterated.
    const own = [...records.values()].filter((record) => record.spec.conversationId === conversationId);
    for (const record of own) {
        await discard(record);
    }
    return own.length;
};

/* STOP CHECKING, the in-memory half, and the ONLY half a daemon on its way down performs. Its counterpart
 * `discard` also takes the watch off disk, and the difference between them is the whole restart feature: a
 * shutdown that dropped the journal entry too would disarm precisely the watches it exists to bring back. */
const forget = (record: WatcherRecord): void => {
    record.cancelled = true;
    if (record.timer !== undefined) {
        clearTimeout(record.timer);
        record.timer = undefined;
    }
    records.delete(record.id);
    publish(record.spec.conversationId);
};

/* THE WATCH IS OVER, for one of the four reasons that end one on purpose: it fired, it timed out, the agent
 * stopped it, or the user did (directly, or by discarding the conversation under it).
 *
 * The journal drop is AWAITED by every caller rather than fired and forgotten, because the window it closes is
 * one this feature would otherwise open by itself: the user presses stop, the container is recreated a second
 * later, and a watch nobody wants comes back from the dead at boot, wearing the same note they just dismissed.
 * A drop that finds no file is a no-op, so an already-journalless watch (the bench's, a restored one already
 * taken) costs nothing here. */
const discard = async (record: WatcherRecord): Promise<void> => {
    forget(record);
    await runtime?.journal.drop(record.id).catch((error: unknown) => {
        runtime?.logger.error({ err: error, watch: record.id }, "watch: journal entry could not be dropped, a restart may re-arm it");
    });
};

/* Tell the fleet card what this conversation is now parked on (watch-state.ts), on every transition and
 * nowhere else: arming one, and each of the four ways one ends (fired, timed out, stopped by the agent,
 * stopped by the user). The check TICK deliberately publishes nothing, a roster broadcast every ten seconds to
 * advance a counter no surface draws would be the busy-loop this module exists to retire, wearing a different
 * hat.
 *
 * The empty array is published like any other value: it is how the last watch ending takes the readout off the
 * card, and the registry is what turns it back into an absent field. */
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

/* THE ENDINGS THAT WAKE, and there are now three of them. `met` and `timeout` are the two the agent is
 * promised when it arms; `restart-expired` is the one the world imposes, a deadline that passed while the
 * daemon was not running. It is a separate word rather than a `timeout` with an asterisk because the two owe
 * the agent different sentences: a timeout means the check ran to the deadline and never passed, which is
 * evidence about the world, while this means the checking stopped, which is only evidence about us. */
type WatchOutcome = "met" | "timeout" | "restart-expired";

const elapsed = (record: WatcherRecord): string => {
    const seconds = Math.round((Date.now() - record.armedAt) / 1000);
    return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

/* The wake's whole prompt. Written to be acted on, not admired: what was being watched, how it ended, and the
 * check's own last words, then one sentence telling the model this is the continuation it asked for. A timeout
 * says so in the first line, because "the condition never came" is a different next step than "it fired". */
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

/* Land the report. A live turn takes it as a steer (delivered between tool calls, like a user message); with no
 * turn live, a fresh one starts on the conversation, resuming its CURRENT provider session so the agent picks
 * the thread back up rather than meeting the task again. startConversationTurn answering undefined means a turn
 * is live but unsteerable, wait for it to end and try again. */
const deliver = async (live: WatcherRuntime, record: WatcherRecord, outcome: WatchOutcome): Promise<void> => {
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

/* END THE WATCH, THEN SAY SO, and strictly in that order: the journal entry goes BEFORE the report is
 * delivered, never after. Delivery has its own durability (startConversationTurn journals the wake, so a
 * daemon death between start and first frame re-runs it), so a crash mid-delivery loses nothing; a crash
 * between a delivered report and an undropped journal entry, on the other hand, would re-arm at boot a watch
 * the agent has already been woken for and wake it a second time. One wake per watch is the promise. */
const fire = (live: WatcherRuntime, record: WatcherRecord, outcome: WatchOutcome): void => {
    void discard(record)
        .then(() => deliver(live, record, outcome))
        .catch((error: unknown) => live.logger.error({ err: error, watch: record.id }, "watch: delivery crashed"));
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
    /* Written down BEFORE the first timer is set, so the ordering that survives a crash is the safe one: an
     * armed-and-journalled watch that never got its timer is restored at boot, while a timer that outran its
     * journal entry would be a watch nothing could bring back, which is the bug this is fixing. */
    await live.journal.record({
        id: record.id,
        conversationId: spec.conversationId,
        command: spec.command,
        note: spec.note,
        intervalMs: record.intervalMs,
        armedAt: record.armedAt,
        deadlineAt: record.deadlineAt,
        cwd: spec.cwd,
        // Names, never values, see watch-journal.ts: the shape of the environment is what restores, its
        // substance is asked of the capability store again.
        envKeys: Object.keys(spec.env),
        turn: spec.turn,
    });
    schedule(live, record);
    // The card learns about the watch in the same breath the map does: this is the moment the conversation
    // stops being finished, and the board has to stop saying that it is.
    publish(spec.conversationId);
    live.logger.info({ watch: record.id, conversationId: spec.conversationId, intervalSeconds, timeoutSeconds, note: spec.note }, "watch: armed");
    return { kind: "armed", id: record.id, intervalSeconds, timeoutSeconds, firstCheck };
};

/* PUT BACK WHAT THE DAEMON DIED UNDER, run once at boot, after the runtime is bound.
 *
 * Whatever is in the journal here is exactly the set of watches that were armed when this daemon's
 * predecessor stopped existing, because every ending that is a DECISION (fired, timed out, stopped by the
 * agent, stopped by the user, conversation discarded) takes the journal entry with it. No graceful shutdown is
 * required, and none can be relied on: the killing signal is usually a SIGKILL from an outside `docker rm -f`,
 * the same reasoning agents-store makes about its persisted `interrupted` status.
 *
 * EVERY ENTRY IS RE-CHECKED BEFORE ANYTHING IS DECIDED, which is the one thing this pass can do that a plain
 * "re-arm the timers" could not. The world kept moving while the daemon was down, and the condition being
 * watched is precisely the kind of thing that resolves during a rebuild: CI going green while the container
 * that was watching it is being recreated is not a corner case, it is the likeliest way this ends. So a check
 * that passes now wakes the conversation immediately, whatever the deadline says, and the agent gets its
 * answer minutes after the restart instead of never.
 *
 * The pass is failure-per-entry, never failure-of-boot: one unreadable worktree or one check that hangs must
 * not hold up the daemon's start, so entries are handled independently and their errors are logged. */
export const restoreWatchers = async (): Promise<void> => {
    const live = runtime;
    if (live === undefined) {
        return;
    }
    const entries = await live.journal.list();
    if (entries.length === 0) {
        return;
    }
    // Asked ONCE for the whole pass rather than per entry: it reads the capability store and every extension's
    // settings, and every watch restoring in this pass wants the same answer.
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

/* The journalled seed as the wake wants it. Zod gives every optional field an explicit `| undefined`, which
 * under exactOptionalPropertyTypes is a different thing from the field being absent, and the difference is
 * load-bearing downstream: `deliver` spreads this into an AgentTurn, where `account: undefined` would be a
 * request to run on an account of that name rather than on the provider's first. So the fields are put back
 * one conditional spread at a time, exactly as watch-server.ts assembled them. */
const seedOf = (turn: JournalledWatch["turn"]): WatcherTurnSeed => ({
    ...(turn.agent !== undefined ? { agent: turn.agent } : {}),
    ...(turn.harness !== undefined ? { harness: turn.harness } : {}),
    ...(turn.account !== undefined ? { account: turn.account } : {}),
    ...(turn.model !== undefined ? { model: turn.model } : {}),
    ...(turn.effort !== undefined ? { effort: turn.effort } : {}),
    ...(turn.isolated === true ? { isolated: true } : {}),
    ...(turn.unattended === true ? { unattended: true } : {}),
});

const restoreOne = async (live: WatcherRuntime, entry: JournalledWatch, env: Record<string, string>): Promise<void> => {
    const context = { watch: entry.id, conversationId: entry.conversationId, note: entry.note };
    /* The two ways a watch can be stale rather than interrupted, both of which mean dropping it in silence is
     * the honest answer: there is no longer anyone to wake, or nowhere to run the check. The conversation is
     * gone or archived-and-purged (agents.routes disarms on discard and purge, so this is only the crash that
     * beat it there), or the worktree it watched from has been landed and removed under it. */
    if (!live.conversationLive(entry.conversationId)) {
        live.logger.info(context, "watch: not restored, its conversation is gone");
        await live.journal.drop(entry.id);
        return;
    }
    if (
        !(await access(entry.cwd).then(
            () => true,
            () => false,
        ))
    ) {
        live.logger.info({ ...context, cwd: entry.cwd }, "watch: not restored, the tree it checked in is gone");
        await live.journal.drop(entry.id);
        return;
    }
    /* The environment, rebuilt rather than restored: fresh values from the live capability store, narrowed to
     * the names the arming turn ran with. That reproduces the persona's withholding without knowing anything
     * about personas (personaCliEnv only ever removes keys), drops a capability revoked while we were down,
     * and declines to hand a check one connected while we were down, which nobody authorised it to have. */
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
        // The ORIGINAL arm time, so the wake still says how long the agent has been waiting rather than how
        // long ago the daemon came back.
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
    // The card gets its readout back, which is the visible half of this whole pass: a conversation that was
    // waiting on something before the restart must not read as finished after it.
    publish(entry.conversationId);
    live.logger.info({ ...context, secondsLeft: Math.round((entry.deadlineAt - Date.now()) / 1000) }, "watch: re-armed after restart");
};

/* The runtime with the seams bound, exported for the tests, which stand fakes into every slot.
 *
 * The returned stop clears every armed watch's TIMER and leaves its journal entry alone (`forget`, not
 * `discard`), which is the difference a restart turns on: a daemon on its way down cannot check anything, but
 * what it was checking is precisely what the next one has to pick up. */
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
        journal: services.watchJournal,
        // The same function that builds a turn's shell environment, so a restored check cannot drift from what
        // an arming turn would actually get (capabilities/turn-env.ts).
        envOf: () => turnCliEnv(services),
        // Archived counts as live: archiving takes a card off the board, it does not disarm anything, and a
        // watch on an archived conversation is the one agents.routes goes out of its way to keep working.
        conversationLive: (conversationId) => services.agents.entry(conversationId) !== undefined,
    });
