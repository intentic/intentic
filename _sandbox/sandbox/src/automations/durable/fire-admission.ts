import { randomUUID } from "node:crypto";
import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import type { JournalledFire } from "../../store/journals/turn-journal.js";
import type { AutomationRecord } from "../automations-store.js";
import type { FireOptions } from "../scheduler.js";
import type { SenderLane } from "../senders.js";
import { perDaemon } from "./daemon-memory.js";
import { checkCondition, conditionOutside, rememberFiredCondition } from "../watch/watch-condition.js";

// A fire's rows on the turn journal (store/journals/turn-journal.ts), from admission to its end: written before it waits
// for a lane, updated once its check passed, cleared however it ends. What is on the journal at boot is what
// fire-resume.ts replays, queued fires in the order they were admitted.

// Admissions this daemon made and runs itself (daemon-memory.ts): a fire admitted while the boot pass reads the journal
// is live here, never a restart's to replay.
const liveOf = perDaemon(() => new Set<string>());
export const liveHere = (services: Pick<Services, "automations">, entry: JournalledFire): boolean => entry.id !== undefined && liveOf.of(services).has(entry.id);

// Takes a fire's own entry off the turn journal, and only its own: another thread of the same automation may be in
// flight beside it, journalled under its conversation. Nothing to take off for a fire that never journalled one.
export const clearJournalled = async (services: Services, automationId: string, conversationId: string | undefined): Promise<void> => {
    if (conversationId === undefined) {
        return;
    }
    liveOf.of(services).delete(conversationId);
    await services.turnJournal
        .clearFire(conversationId)
        .catch((error: Error) => services.logger.warn({ err: error, automation: automationId }, "turn journal: fire not cleared"));
};

// The fire's check, run once: a pass is written onto the fire's journal row before the watch's baseline moves or a
// first-fire automation retires, so a restart in between replays that pass (`checked`) rather than checking again
// against a baseline it already moved.
export const checkFireCondition = async (services: Services, automation: AutomationRecord, payload: string | undefined, entry: JournalledFire | undefined) => {
    const condition = entry?.checked === true
        ? { kind: "go" as const, ...opt("observed", entry.observed), ...opt("outside", conditionOutside(automation)), ...opt("value", entry.observedValue),
            commit: () => rememberFiredCondition(services, automation, entry.observedValue, entry.startedAt) }
        : await checkCondition(services, automation, payload);
    if (condition.kind !== "go") {
        return condition;
    }
    if (entry !== undefined) {
        await services.turnJournal.recordFire({ ...entry, checked: true, ...opt("observed", condition.observed), ...opt("observedValue", condition.value) });
    }
    await condition.commit?.();
    // Waiting for one thing: it has come, so the automation retires before anything runs. The snapshot above lets a
    // restart in between run the fire it retired for (`resumable`).
    if (automation.until === "first-fire") {
        await services.automations.setEnabled(automation.id, false);
    }
    return condition;
};

// A fire's journal row: what it was set off with, and whose thread and lane it ran on. Each field is set only when the
// fire carried it, so a row read back holds exactly what the fire had.
export const journalledFire = (
    automationId: string,
    conversationId: string,
    attempts: number,
    carried: {
        readonly payload: string | undefined;
        readonly origin: AgentOrigin | undefined;
        readonly title: string | undefined;
        readonly lane: SenderLane | undefined;
        readonly thread: string | undefined;
        readonly sessionId: string | undefined;
    },
): JournalledFire => {
    const row: JournalledFire = { kind: "automation", automationId, conversationId, startedAt: Date.now(), attempts };
    return {
        ...row,
        ...opt("payload", carried.payload),
        ...opt("origin", carried.origin),
        ...opt("title", carried.title),
        ...opt("lane", carried.lane === undefined ? undefined : { ...opt("actsAs", carried.lane.actsAs), requireApproval: carried.lane.requireApproval }),
        ...opt("thread", carried.thread),
        ...opt("sessionId", carried.sessionId),
    };
};

// A fire's row at admission, before it waits for its lane: keyed on its own id, since several may wait on one
// conversation. `conversationId` is the caller's, or one minted for it (`minted`, so a replay still mints its own seat).
export const queuedFire = (automationId: string, conversationId: string, options: FireOptions): JournalledFire => ({
    ...journalledFire(automationId, options.conversationId ?? conversationId, options.attempts ?? 0, {
        payload: options.payload, origin: options.origin, title: options.title, lane: options.lane, thread: options.thread, sessionId: options.sessionId,
    }),
    id: options.held === undefined ? randomUUID() : heldFireId(options.held),
    state: "queued",
    ...opt("minted", options.conversationId === undefined ? true : undefined),
    ...opt("cleared", options.cleared),
    ...opt("observed", options.observed),
    ...opt("late", options.late),
    ...opt("held", options.held),
    ...opt("inboxIds", options.inboxIds === undefined ? undefined : [...options.inboxIds]),
    ...opt("allowedTools", options.allowedTools === undefined ? undefined : [...options.allowedTools]),
});

// Writes a fire's admission row, marking it live in this daemon.
export const admitFire = async (services: Pick<Services, "turnJournal" | "automations">, entry: JournalledFire): Promise<void> => {
    if (entry.id !== undefined) {
        liveOf.of(services).add(entry.id);
    }
    await services.turnJournal.recordFire(entry);
};

// A fire's admission: durable before it waits, so a restart replays it from the journal (fire-resume.ts), and only then
// is its source (an inbox row, a one-time wake's switch) let go. A journal that cannot be written costs the replay, not
// the fire. A source that cannot be let go keeps the fire instead (the inbox replays it, the tick retries it): false, and
// the fire does not run now.
export const admitThenLetGo = async (services: Services, automationId: string, entry: JournalledFire, letGo: (() => Promise<void>) | undefined): Promise<boolean> => {
    await admitFire(services, entry).catch((error: Error) =>
        services.logger.warn({ err: error, automation: automationId }, "turn journal: fire not admitted, a restart will not replay it"),
    );
    try {
        await letGo?.();
        return true;
    } catch (error) {
        services.logger.warn({ err: error, automation: automationId }, "the fire's source could not be let go, so it does not run now");
        await clearJournalled(services, automationId, entry.id);
        return false;
    }
};

// A released hold's journal key: the approve route and the countdown scan record it under the same one, so two releases
// racing for one hold write one row.
const heldFireId = (held: string): string => `held-${held}`;

// Drops the row recordHeldWake wrote for a release that will not run (its automation is gone or switched off).
export const forgetHeldWake = (services: Services, held: string): Promise<void> => clearJournalled(services, "held", heldFireId(held));
