import { randomInt } from "node:crypto";
import { briefDuration, clamp } from "@intentic/base/format";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { profileOf, type TurnProfile, type WatchOutcome, watchWakePrompt } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";
import { turnCliEnv } from "../../capabilities/turn-env.js";
import type { Services } from "../../composition.js";
import { whenFileAppears } from "../tools/file-appears.js";
import { deliverWake, type WakeDoors } from "../run/turn/wake-delivery.js";
import { type CheckOptions, type CheckResult, type RunCheck, watchCheck, type WatchPlacement } from "./watch-check.js";
import type { JournalledWatch, WatchJournal } from "./watch-journal.js";

// A daemon-owned condition watch wakes its conversation when it fires, times out or can no longer run, never silently.

export type { CheckResult, RunCheck, WatchPlacement } from "./watch-check.js";

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
// Short, since the agent types ids back; random, so a restart never reissues an id an old chat row still names.
const ID_ALPHABET_SPAN = 36 ** 4;

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
    // An isolated conversation's world, rebuilt for every check; absent for the workspace root.
    readonly placement?: WatchPlacement;
    // The source a fetching check's output is outside content from.
    readonly outside?: string;
    // A local file whose appearance is the condition moving: checked at once, the interval only the floor.
    readonly signalPath?: string;
    // The arming turn's profile, snapshotted at arm time: the wake continues that turn rather than starting a new one.
    readonly profile: TurnProfile;
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
    // The signal file arrived while a check was already running, so the next one goes at once.
    recheck: boolean;
    unsignal: (() => void) | undefined;
}

export interface WatcherSummary {
    readonly id: string;
    readonly note: string;
    readonly command: string;
    readonly intervalSeconds: number;
    readonly checks: number;
    readonly secondsLeft: number;
}

// Bound at boot, since a watch outlives the turn that armed it and wakes its conversation through the TurnStarter port.
export interface WatcherRuntime extends WakeDoors {
    readonly logger: Logger;
    readonly runCheck: RunCheck;
    // What an armed watch IS, on disk, so a daemon that dies under one can put it back (watch-journal.ts).
    readonly journal: WatchJournal;
    // The environment a check runs with today, asked at restore time, not off disk, so no credential is persisted.
    readonly envOf: () => Promise<Record<string, string>>;
    // Whether a journalled watch's conversation still exists, archived or not.
    readonly conversationLive: (conversationId: string) => boolean;
    // Where each conversation's watches are held, and its card told of them.
    readonly conversations: Pick<ConversationActors, "holdings" | "send">;
}

let runtime: WatcherRuntime | undefined;

// A conversation's armed watches, by watch id; a dispose takes each the way a disarm would, with no card left to tell.
const WATCHES: Holding<WatcherRecord> = { name: "watches", dropped: (record) => disposed(record) };
// Ids this daemon armed, held by the conversation each was armed for; restore skips them, since it restores only what
// the previous daemon left.
const MINTED: Holding<true> = { name: "minted watch ids" };

const nextId = (live: WatcherRuntime, conversationId: string): string => {
    const armed = live.conversations.holdings(WATCHES);
    const minted = live.conversations.holdings(MINTED);
    for (;;) {
        const id = `watch-${randomInt(ID_ALPHABET_SPAN).toString(36).padStart(4, "0")}`;
        if (!armed.has(id) && !minted.has(id)) {
            minted.hold(conversationId, id, true);
            return id;
        }
    }
};

// Every watch of one conversation; none while no runtime is started, since none can be armed then.
const watchesOf = (conversationId: string): readonly WatcherRecord[] => runtime?.conversations.holdings(WATCHES).of(conversationId) ?? [];

// Idle-stop's probe: a machine mid-watch is not idle, stopping it is how a watch silently never fires.
export const armedWatcherCount = (): number => runtime?.conversations.holdings(WATCHES).entries().length ?? 0;

export const listWatchers = (conversationId: string): WatcherSummary[] =>
    watchesOf(conversationId).map((record) => ({
        id: record.id,
        note: record.spec.note,
        command: record.spec.command,
        intervalSeconds: Math.round(record.intervalMs / 1000),
        checks: record.checks,
        secondsLeft: Math.max(0, Math.round((record.deadlineAt - Date.now()) / 1000)),
    }));

// Only a conversation's own watches answer to it, the same scoping rule subagent-wait holds.
export const cancelWatcher = async (conversationId: string, id: string): Promise<boolean> => {
    const live = runtime;
    const record = live?.conversations.holdings(WATCHES).get(id);
    if (live === undefined || record === undefined || record.spec.conversationId !== conversationId) {
        return false;
    }
    await discard(live, record);
    return true;
};

// The user's own disarm-the-lot, reachable without a running turn (unlike the agent's `watch stop`); walks the same
// `discard` every ending uses, and answers how many it took.
export const cancelWatchersFor = async (conversationId: string): Promise<number> => {
    const live = runtime;
    if (live === undefined) {
        return 0;
    }
    // Snapshotted before the loop: `discard` drops from the holding being read.
    const own = live.conversations.holdings(WATCHES).of(conversationId);
    for (const record of own) {
        await discard(live, record);
    }
    return own.length;
};

// Stops a record's checking; an in-flight check sees the flag and schedules nothing after it.
const stopChecking = (record: WatcherRecord): void => {
    record.cancelled = true;
    record.unsignal?.();
    record.unsignal = undefined;
    if (record.timer !== undefined) {
        clearTimeout(record.timer);
        record.timer = undefined;
    }
};

// Its conversation is gone for good: nothing left to check, and nothing a restart should bring back.
const disposed = (record: WatcherRecord): void => {
    stopChecking(record);
    const live = runtime;
    if (live !== undefined) {
        void dropEntry(live, record.id);
    }
};

// Stop checking, the in-memory half only, and the only half a daemon on its way down performs; `discard` also drops the
// journal entry, and a shutdown that did that too would disarm exactly the watches this exists to bring back.
const forget = (live: WatcherRuntime, record: WatcherRecord): void => {
    stopChecking(record);
    live.conversations.holdings(WATCHES).drop(record.id);
    publish(live, record.spec.conversationId);
};

const dropEntry = async (live: WatcherRuntime, id: string): Promise<void> => {
    await live.journal.drop(id).catch((error: unknown) => {
        live.logger.error({ err: error, watch: id }, "watch: journal entry could not be dropped, a restart may re-arm it");
    });
};

// A stop by the agent or the user; awaited, so a recreate cannot resurrect a dismissed watch.
const discard = async (live: WatcherRuntime, record: WatcherRecord): Promise<void> => {
    forget(live, record);
    await dropEntry(live, record.id);
};

// Tells the fleet card what the conversation is parked on, on every transition, nowhere else; a tick publishes nothing.
// The empty array publishes like any value, letting the registry turn it back into absence.
const publish = (live: WatcherRuntime, conversationId: string): void => {
    live.conversations.send(conversationId, {
        kind: "watches-shown",
        watches: live.conversations
            .holdings(WATCHES)
            .of(conversationId)
            .map((record) => ({
                id: record.id,
                note: record.spec.note,
                intervalSeconds: Math.round(record.intervalMs / 1000),
                deadlineAt: record.deadlineAt,
            })),
    });
};

const elapsed = (record: WatcherRecord): string => briefDuration(Math.round((Date.now() - record.armedAt) / 1000));

// A broken check's reason leads, and a fetching check's words are wrapped as outside content.
const checkSays = (check: CheckResult, outside: string | undefined): string => {
    const said = outside === undefined || check.output === "" ? check.output : wrapOutsideContent(check.output, { source: outside });
    return check.broken === undefined ? said : [`The check cannot run: ${check.broken}.`, said].filter((part) => part !== "").join("\n");
};

// Composed through the contract, never spelled here: the same wording is what three readers turn back into the notice
// row a person sees, so a wake worded locally would reach the model fine and reach the reader as their own typing.
const report = (record: WatcherRecord, outcome: WatchOutcome): string =>
    watchWakePrompt({
        outcome,
        id: record.id,
        note: record.spec.note,
        elapsed: elapsed(record),
        command: record.spec.command,
        exitCode: record.last.exitCode,
        output: checkSays(record.last, record.spec.outside),
    });

// A wake continues the arming turn on its own routing, not a new one; a conversation busy with a turn that cannot take
// it queues it, where every window sees it until it goes.
const deliver = async (live: WatcherRuntime, record: WatcherRecord, outcome: WatchOutcome): Promise<void> => {
    const prompt = report(record, outcome);
    const receipt = await deliverWake(live, {
        conversationId: record.spec.conversationId,
        prompt,
        voice: "sandbox",
        ...(record.spec.outside === undefined ? {} : { outside: record.spec.outside }),
        profile: record.spec.profile,
    });
    if ("invalid" in receipt) {
        // The report goes into the log rather than nowhere.
        live.logger.error({ watch: record.id, conversationId: record.spec.conversationId, report: prompt, invalid: receipt.invalid }, "watch: report could not be delivered");
        return;
    }
    if ("why" in receipt) {
        live.logger.info({ watch: record.id, conversationId: record.spec.conversationId, why: receipt.why }, "watch: its conversation took nothing");
        return;
    }
    live.logger.info({ watch: record.id, outcome, conversationId: record.spec.conversationId, delivered: receipt.delivered }, "watch: report delivered");
};

const entryOf = (record: WatcherRecord): JournalledWatch => ({
    id: record.id,
    conversationId: record.spec.conversationId,
    command: record.spec.command,
    note: record.spec.note,
    intervalMs: record.intervalMs,
    armedAt: record.armedAt,
    deadlineAt: record.deadlineAt,
    cwd: record.spec.cwd,
    ...(record.spec.placement === undefined ? {} : { placement: record.spec.placement }),
    ...(record.spec.outside === undefined ? {} : { outside: record.spec.outside }),
    ...(record.spec.signalPath === undefined ? {} : { signalPath: record.spec.signalPath }),
    // Names, never values: the environment's shape restores, its substance is asked of the capability store again.
    envKeys: Object.keys(record.spec.env),
    turn: record.spec.profile,
});

// At least once: the entry stays journalled, marked firing, until its wake has landed.
const fire = (live: WatcherRuntime, record: WatcherRecord, outcome: WatchOutcome): void => {
    forget(live, record);
    void live.journal
        .record({ ...entryOf(record), firing: { outcome, check: record.last } })
        .catch((error: unknown) =>
            live.logger.warn({ err: error, watch: record.id }, "watch: firing could not be journalled, a restart now would lose it"),
        )
        .then(() => deliver(live, record, outcome))
        .then(() => dropEntry(live, record.id))
        .catch((error: unknown) => live.logger.error({ err: error, watch: record.id }, "watch: delivery crashed"));
};

const checkOptions = (spec: WatcherSpec): CheckOptions => ({
    cwd: spec.cwd,
    env: spec.env,
    ...(spec.placement === undefined ? {} : { placement: spec.placement }),
});

// Undefined keeps waiting.
const verdictOf = (check: CheckResult, deadlineAt: number): WatchOutcome | undefined => {
    if (check.broken !== undefined) {
        return "broken";
    }
    if (check.exitCode === 0) {
        return "met";
    }
    return Date.now() >= deadlineAt ? "timeout" : undefined;
};

// The next check is scheduled only once this one finishes.
const tick = async (live: WatcherRuntime, record: WatcherRecord): Promise<void> => {
    record.checks += 1;
    record.last = await live.runCheck(record.spec.command, checkOptions(record.spec));
    if (record.cancelled) {
        return;
    }
    const outcome = verdictOf(record.last, record.deadlineAt);
    if (outcome === undefined) {
        schedule(live, record);
        return;
    }
    fire(live, record, outcome);
};

const runTick = (live: WatcherRuntime, record: WatcherRecord): void => {
    void tick(live, record).catch((error: unknown) => {
        live.logger.error({ err: error, watch: record.id }, "watch: check crashed, watch dropped");
        // Off disk too: a check that crashes the runner is not a watch a restart should faithfully re-arm.
        void discard(live, record);
    });
};

const schedule = (live: WatcherRuntime, record: WatcherRecord): void => {
    // Never past the deadline: a long interval with little time left checks once more, not sleeping through it.
    const wait = record.recheck ? 0 : Math.min(record.intervalMs, Math.max(0, record.deadlineAt - Date.now()));
    record.recheck = false;
    record.timer = setTimeout(() => {
        record.timer = undefined;
        runTick(live, record);
    }, wait);
    // A watchdog must never hold the event loop open on its own (idle-stop's rule, same reason).
    record.timer.unref();
};

// No timer means a check is running or the arm is still journalling; either schedules next, and goes at once.
const recheck = (live: WatcherRuntime, record: WatcherRecord): void => {
    if (record.cancelled) {
        return;
    }
    if (record.timer === undefined) {
        record.recheck = true;
        return;
    }
    clearTimeout(record.timer);
    record.timer = undefined;
    runTick(live, record);
};

const follow = (live: WatcherRuntime, record: WatcherRecord): void => {
    if (record.spec.signalPath !== undefined) {
        record.unsignal = whenFileAppears(record.spec.signalPath, () => recheck(live, record));
    }
};

export type ArmOutcome =
    // The condition already held when asked, nothing armed, no wake coming.
    | { readonly kind: "already-met"; readonly firstCheck: CheckResult }
    // The condition already held and the wake is being delivered anyway.
    | { readonly kind: "reported"; readonly id: string; readonly firstCheck: CheckResult }
    | {
          readonly kind: "armed";
          readonly id: string;
          readonly intervalSeconds: number;
          readonly timeoutSeconds: number;
          readonly firstCheck: CheckResult;
      }
    | { readonly kind: "refused"; readonly reason: string };

export interface ArmOptions {
    // Wake even when the first check already passes, for news the conversation has not seen yet.
    readonly reportIfMet?: boolean;
}

// Arms a watch; the first check runs now, inside this call, so a broken command fails to the agent's face instead of
// reading as still-waiting for hours. Exit 0 on the first check arms nothing.
export const armWatcher = async (spec: WatcherSpec, options: ArmOptions = {}): Promise<ArmOutcome> => {
    const live = runtime;
    if (live === undefined) {
        return { kind: "refused", reason: "Watching is not available in this runtime." };
    }
    if (listWatchers(spec.conversationId).length >= MAX_PER_CONVERSATION) {
        return { kind: "refused", reason: `This conversation already has ${MAX_PER_CONVERSATION} armed watches, stop one first.` };
    }
    const firstCheck = await live.runCheck(spec.command, checkOptions(spec));
    if (firstCheck.broken !== undefined) {
        return { kind: "refused", reason: `The check cannot run: ${firstCheck.broken}.` };
    }
    if (firstCheck.exitCode === 0 && options.reportIfMet !== true) {
        return { kind: "already-met", firstCheck };
    }
    const intervalSeconds = clamp(Math.round(spec.intervalSeconds ?? DEFAULT_INTERVAL_S), MIN_INTERVAL_S, MAX_INTERVAL_S);
    const timeoutSeconds = clamp(Math.round(spec.timeoutSeconds ?? DEFAULT_TIMEOUT_S), MIN_TIMEOUT_S, MAX_TIMEOUT_S);
    const now = Date.now();
    const record: WatcherRecord = {
        id: nextId(live, spec.conversationId),
        spec,
        intervalMs: intervalSeconds * 1000,
        armedAt: now,
        deadlineAt: now + timeoutSeconds * 1000,
        checks: 1,
        last: firstCheck,
        timer: undefined,
        cancelled: false,
        recheck: false,
        unsignal: undefined,
    };
    if (firstCheck.exitCode === 0) {
        fire(live, record, "met");
        return { kind: "reported", id: record.id, firstCheck };
    }
    live.conversations.holdings(WATCHES).hold(spec.conversationId, record.id, record);
    // Written before the first timer, so a crash leaves an armed watch restorable, never an orphan timer.
    await live.journal.record(entryOf(record));
    schedule(live, record);
    follow(live, record);
    // The card learns in the same breath the holding does: this is the moment the conversation stops looking finished.
    publish(live, spec.conversationId);
    live.logger.info({ watch: record.id, conversationId: spec.conversationId, intervalSeconds, timeoutSeconds, note: spec.note }, "watch: armed");
    return { kind: "armed", id: record.id, intervalSeconds, timeoutSeconds, firstCheck };
};

// Once at boot; every armed entry is re-checked first, since the condition can resolve mid-restart.
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

// Absent stays absent: spreading `account: undefined` would name an account rather than leave it unset.
const specOf = (entry: JournalledWatch, env: Record<string, string>): WatcherSpec => ({
    conversationId: entry.conversationId,
    command: entry.command,
    note: entry.note,
    cwd: entry.cwd,
    // Fresh store values narrowed to the arming keys, so withholding and rotation apply.
    env: Object.fromEntries(entry.envKeys.filter((key) => env[key] !== undefined).map((key) => [key, env[key] as string])),
    ...(entry.placement === undefined ? {} : { placement: entry.placement }),
    ...(entry.outside === undefined ? {} : { outside: entry.outside }),
    ...(entry.signalPath === undefined ? {} : { signalPath: entry.signalPath }),
    profile: profileOf(entry.turn),
});

const checkOf = (check: NonNullable<JournalledWatch["firing"]>["check"]): CheckResult => ({
    exitCode: check.exitCode,
    output: check.output,
    ...(check.broken === undefined ? {} : { broken: check.broken }),
});

const restoreOne = async (live: WatcherRuntime, entry: JournalledWatch, env: Record<string, string>): Promise<void> => {
    if (live.conversations.holdings(MINTED).has(entry.id) || live.conversations.holdings(WATCHES).has(entry.id)) {
        return;
    }
    const context = { watch: entry.id, conversationId: entry.conversationId, note: entry.note };
    if (!live.conversationLive(entry.conversationId)) {
        live.logger.info(context, "watch: not restored, its conversation is gone");
        await live.journal.drop(entry.id);
        return;
    }
    const spec = specOf(entry, env);
    const firing = entry.firing;
    const record: WatcherRecord = {
        id: entry.id,
        spec,
        intervalMs: entry.intervalMs,
        // The original arm time, so the wake reports real wait time, not time since the daemon came back.
        armedAt: entry.armedAt,
        deadlineAt: entry.deadlineAt,
        checks: 1,
        last: firing === undefined ? await live.runCheck(entry.command, checkOptions(spec)) : checkOf(firing.check),
        timer: undefined,
        cancelled: false,
        recheck: false,
        unsignal: undefined,
    };
    if (firing !== undefined) {
        live.logger.info(context, "watch: it fired before the restart and its wake had not landed, delivering it now");
        fire(live, record, firing.outcome);
        return;
    }
    live.conversations.holdings(WATCHES).hold(entry.conversationId, record.id, record);
    const outcome = verdictOf(record.last, entry.deadlineAt);
    if (outcome !== undefined) {
        live.logger.info({ ...context, outcome }, "watch: it ended while the daemon was down, waking now");
        // A deadline that passed unchecked is the restart's ending, not a timeout.
        fire(live, record, outcome === "timeout" ? "restart-expired" : outcome);
        return;
    }
    schedule(live, record);
    follow(live, record);
    // The card gets its readout back: a conversation waiting before the restart must not read as finished after it.
    publish(live, entry.conversationId);
    live.logger.info({ ...context, secondsLeft: Math.round((entry.deadlineAt - Date.now()) / 1000) }, "watch: re-armed after restart");
};

// The runtime with its seams bound, exported so tests can stand fakes into every slot. The returned stop clears every
// timer and leaves journal entries alone (`forget`, not `discard`): what a dying daemon was checking is exactly what
// the next one must pick up.
export const startWatcherRuntime = (live: WatcherRuntime): (() => void) => {
    runtime = live;
    return () => {
        for (const [, record] of live.conversations.holdings(WATCHES).entries()) {
            forget(live, record);
        }
        live.conversations.holdings(MINTED).clear();
        runtime = undefined;
    };
};

export const startWatchers = (services: Services): (() => void) =>
    startWatcherRuntime({
        logger: services.logger,
        runCheck: watchCheck(services.turnIsolation),
        turns: services.turns,
        sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId),
        journal: services.watchJournal,
        // The same function that builds a turn's shell env, so a restored check can't drift from an arming turn's.
        envOf: () => turnCliEnv(services),
        // Archive disarms its own watches, so an archived conversation's entry is one still being delivered.
        conversationLive: (conversationId) => services.agents.entry(conversationId) !== undefined,
        conversations: services.conversations,
    });
