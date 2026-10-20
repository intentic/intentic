import { consumeInbox } from "./durable/inbox-store.js";
import { liveHere } from "./durable/fire-admission.js";
import { resumeListenerInbox } from "./listeners.js";
import { resumeWorkspaceInbox } from "./workspace-events.js";
import type { RestartResume } from "../agent/run/turn/recovery/restart-resume-policy.js";
import { consumeEntry, type JournalEntry, resumeBars, spendAttempt } from "../store/journals/turn-journal.js";
import { settingsResume } from "../agent/run/turn/turn-resume.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { channelAnswerSink } from "../extensions/listener/listener-deliver.js";
import { fireOnThread, resumable, type ThreadFireOptions, type ThreadPlace } from "./scheduler.js";

type JournalledFire = Extract<JournalEntry, { kind: "automation" }>;

// A fire admitted but not yet run when the daemon stopped: it never started, so nothing was interrupted, and it runs
// as it was admitted, its own gates and all.
const queued = (entry: JournalledFire): boolean => entry.state === "queued";

// What the re-fire is handed of the fire it replaces: the trigger inputs it was snapshotted with, and the lane its
// sender's rule decided, so a stranger put on a narrow persona comes back on that persona rather than the automation's.
// An interrupted fire's lane approval was answered when it first ran, so its re-fire asks for none; a queued one's was not.
const refireOptions = (entry: JournalledFire): ThreadFireOptions => {
    const attempts = queued(entry) ? entry.attempts : entry.attempts + 1;
    return {
        // It waits behind whatever runs, rather than being dropped as overlapping: it is owed its run.
        overlap: "queue",
        // Only the approval gate is skipped on an interrupted fire, since the wake was already past it; a held wake's
        // replay was past the guard too.
        ...opt("cleared", queued(entry) || entry.cleared === "both" ? entry.cleared : "approval"),
        // Its own journal row, so the re-fire runs under it rather than admitting a second.
        admission: { ...entry, attempts },
        attempts,
        ...opt("observed", entry.observed),
        ...opt("late", entry.late),
        ...opt("held", entry.held),
        ...opt("allowedTools", entry.allowedTools),
        ...opt("payload", entry.payload),
        ...opt("origin", entry.origin),
        ...opt("title", entry.title),
        ...opt("lane", entry.lane === undefined ? undefined : { actsAs: entry.lane.actsAs, requireApproval: queued(entry) && entry.lane.requireApproval }),
    };
};

// The conversation the re-fire continues: the one it was cut on, on the thread and provider session it belonged to, so
// the thread is settled after it like the original would have been and its next message resumes the same session. A
// queued fire whose id was only minted at admission has no seat yet, and runs as a fresh fire would.
const refirePlace = (entry: JournalledFire): ThreadPlace => ({
    key: entry.thread,
    conversationId: queued(entry) && entry.minted === true ? undefined : entry.conversationId,
    sessionId: entry.sessionId,
});

// Records the interruption on the run's own record, the only place it shows. A queued fire never started.
const recordInterrupted = async (services: Services, entry: JournalledFire, now: number): Promise<void> => {
    await services.automations
        .recordRun(entry.automationId, {
            at: now,
            outcome: "interrupted",
            detail: "the sandbox restarted while this run was in flight",
            conversationId: entry.conversationId,
        })
        .catch((error: Error) => services.logger.warn({ err: error, automation: entry.automationId }, "interrupted run not recorded"));
};

// Fires it again on the thread it belonged to, its answer going where the original's would have: a Visitor chat's outbox
// or the gateway channel's thread (the requester's live stream died with the daemon). Answers once the fire is admitted,
// so the next entry is admitted behind it and queued fires keep their order; the run itself is not waited for.
const refire = (services: Services, automation: Parameters<typeof fireOnThread>[1], entry: JournalledFire): Promise<void> => {
    // Only a message from a place (a Visitor chat, a channel) has somewhere to be answered.
    const sink = entry.origin?.channelId === undefined ? undefined : (services.outboxStreamFor(entry.origin) ?? channelAnswerSink(services, entry.origin));
    return new Promise<void>((resolve) => {
        void fireOnThread(services, automation, refirePlace(entry), { ...refireOptions(entry), ...opt("stream", sink?.stream), accepted: async () => resolve() })
            .then(async () => {
                resolve();
                await sink?.settled();
            })
            .catch((error: Error) => {
                resolve();
                services.logger.error({ err: error, automation: entry.automationId }, "interrupted fire failed to resume");
            });
    });
};

// One journalled fire: an interrupted one recorded so, then re-fired or left so; a queued one run as admitted.
const resumeFire = async (services: Services, entry: JournalledFire, now: number, policy: RestartResume): Promise<void> => {
    if (!queued(entry)) {
        await recordInterrupted(services, entry, now);
        const { spent, stale } = resumeBars(entry, now);
        if (!policy.resume || spent || stale) {
            await consumeEntry(services, entry);
            services.logger.info({ entry: entry.kind, spent, stale, autoResumeOnRestart: policy.resume }, "interrupted turn not resumed: the interruption stands on the record");
            return;
        }
    }
    // Re-fires through fireAutomation, the same road an approved wake takes, re-reading the prompt in case it changed.
    const automation = await services.automations.get(entry.automationId);
    if (automation === undefined || !resumable(automation)) {
        // Consumed rather than kept: it can never fire, and keeping it would fabricate a second run next boot.
        await consumeEntry(services, entry);
        services.logger.info({ automation: entry.automationId }, "interrupted fire not resumed, the automation is gone or disabled");
        return;
    }
    if (!queued(entry)) {
        await spendAttempt(services, entry);
    }
    // A one-time wake is switched off once its fire is admitted; a crash in between must not leave the tick to fire it
    // a second time beside this replay.
    if (automation.trigger.kind === "once" && automation.enabled) {
        await services.automations.setEnabled(automation.id, false);
    }
    // A released hold whose release died between journalling and taking the hold out: the yes was given, the hold goes.
    if (entry.held !== undefined) {
        await services.heldWakes.remove(entry.held);
    }
    await refire(services, automation, entry);
    services.logger.info({ automation: entry.automationId, queued: queued(entry) }, "restart auto-refire fired");
};

// A fire that was held for approval after its admission was journalled: the hold is what stands, and its release
// replays it, so the admission row is only a leftover. A hold this build cannot read still stands.
const heldSince = async (services: Services, entry: JournalledFire): Promise<boolean> => {
    if (entry.id === undefined || entry.held !== undefined) {
        return false;
    }
    const hold = await services.heldWakes.get(entry.id).catch((error: Error) => {
        services.logger.warn({ err: error, automation: entry.automationId }, "held wake unreadable at boot, its admission is left to the hold");
        return true;
    });
    return hold !== undefined;
};

// Runs once at boot, beside the engine's own pass over the turns it died under (agent/run/turn/turn-resume.ts). Each
// entry is consumed or spent before it fires, so a fire that kills the daemon can't loop the boot. Interrupted fires and
// queued ones come back in the order they were admitted. First the inbox rows (durable/inbox-store.ts) a journalled fire already
// took over are dropped, so `resumeAutomationInboxes`, after this, fires nothing twice.
// `policy`: whether this boot resumes what the restart cut (agent/run/turn/recovery/restart-resume-policy.ts), decided once for
// every pass; absent, it is the settings' autoResumeOnRestart alone.
export const resumeInterruptedFires = async (services: Services, now: number = Date.now(), policy?: RestartResume): Promise<void> => {
    const listed = await services.turnJournal.list().catch((error: unknown): JournalEntry[] => {
        services.logger.warn({ err: error }, "turn journal: unreadable at boot, no interrupted fire is re-fired");
        return [];
    });
    const fires = listed.filter((entry): entry is JournalledFire => entry.kind === "automation" && !liveHere(services, entry));
    await consumeInbox(services, fires.flatMap((entry) => entry.inboxIds ?? []));
    const resume = policy ?? (await settingsResume(services));
    for (const entry of fires) {
        if (await heldSince(services, entry)) {
            await consumeEntry(services, entry);
            continue;
        }
        await resumeFire(services, entry, now, resume);
    }
};

// After the journalled fires (bootstrap/boot-resumes.ts): what still waited in the inboxes when the daemon stopped, a
// listener message in its debounce or behind a running fire, a workspace event in its chore's queue, goes back where it
// waited, in arrival order. Never rejects: a failure is logged, and the rows stay for the next boot.
export const resumeAutomationInboxes = async (services: Services): Promise<void> => {
    await resumeListenerInbox(services).catch((error: Error) => services.logger.error({ err: error }, "listener inbox could not be replayed"));
    await resumeWorkspaceInbox(services).catch((error: Error) => services.logger.error({ err: error }, "workspace-event inbox could not be replayed"));
};
