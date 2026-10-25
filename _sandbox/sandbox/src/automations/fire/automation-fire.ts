import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import type { Services } from "../../composition.js";
import type { OutboxSink } from "../../webchat/webchat-outbox.js";
import type { AutomationRecord } from "../automations-store.js";
import { opt } from "../../opt.js";
import { perDaemon } from "../durable/daemon-memory.js";
import { admitFire, admitThenLetGo, queuedFire } from "../durable/fire-admission.js";
import { channelAnswerSink } from "../../extensions/listener/listener-deliver.js";
import type { ReleasedWake } from "../held-wakes-store.js";
import { mintConversationId } from "./fire-sessions.js";
import type { FireOptions, FireOutcome, ThreadPlace, ThreadFireOptions } from "./fire-options.js";
import { runFire } from "./run-fire.js";

const QUEUED_NOTICE = "Another task of mine is still running; I start on this one as soon as it finishes.";

// How the fires of one automation take turns, shared by the tick, the dispatchers, the doors and the fire route.
// - A fire no provider thread owns (a schedule, a webhook, a workspace event, a channel-level message, a Visitor chat, a
//   pressed Run now) runs ALONE, as every fire did before threads shared: it waits for every fire of its automation
//   already admitted, and every fire admitted after it waits for it. Such an automation still never overlaps itself.
// - A fire on a provider's own thread (the Discord or Slack thread a team-chat mention is answered in) SHARES its
//   automation with the fires on its other threads: it waits only for a fire running alone that was admitted before it,
//   for the last fire on its own conversation, and for one of `automationThreadsAtOnce` slots. Two people mentioning
//   the bot in two threads are answered side by side; one more than the setting allows is told it is queued.
// So two fires of one automation overlap only on two conversations, which is what lets the turn journal file a fire
// in flight under its conversation (store/journals/turn-journal.ts).
interface FireLanes {
    // Settles once every fire admitted so far has: what a fire running alone waits for, and what automationIdle reads.
    all: Promise<void>;
    // Settles once the last fire admitted to run alone has: what a thread's fire admitted after it waits behind.
    alone: Promise<void>;
    // The last fire admitted on each shared conversation, settling with it: what the next one there waits behind.
    readonly conversations: Map<string, Promise<void>>;
    // Fires admitted and not yet settled, all of them and those running alone; the lanes go when nothing is admitted.
    admitted: number;
    admittedAlone: number;
    // Thread fires working now, how many may (the setting as last read), and those waiting for a slot, oldest first.
    working: number;
    cap: number;
    readonly waiting: (() => void)[];
}

// Each daemon's lanes, by automation (durable/daemon-memory.ts).
const fireLanesOf = perDaemon(() => new Map<string, FireLanes>());

const openLanes = (): FireLanes => ({
    all: Promise.resolve(),
    alone: Promise.resolve(),
    conversations: new Map(),
    admitted: 0,
    admittedAlone: 0,
    working: 0,
    cap: 1,
    waiting: [],
});

// The conversation a fire shares its automation on, or undefined for one that runs alone. A fire shares when it
// belongs to a thread (its thread key and conversation) that is a provider's own thread, which only its origin says: a
// channel-level message's origin names no thread. All three ride a held wake's snapshot and the turn journal, so an
// approved hold and a restart's re-fire take turns exactly as the fire they replay did.
const sharedConversationOf = ({ thread, conversationId, origin }: FireOptions): string | undefined =>
    thread !== undefined && origin?.threadId !== undefined ? conversationId : undefined;

// Hands free slots to the thread fires waiting longest, as many as the setting allows.
const fillSlots = (lanes: FireLanes): void => {
    while (lanes.working < lanes.cap && lanes.waiting.length > 0) {
        lanes.working += 1;
        lanes.waiting.shift()?.();
    }
};

// How many threads of one automation may be worked on at once, read per fire so a change holds from the next thread
// on. A read that fails works one thread at a time, as every automation did before the setting existed.
const threadsAtOnce = async (services: Pick<Services, "sandboxSettings" | "logger">): Promise<number> => {
    try {
        return (await services.sandboxSettings.get()).automationThreadsAtOnce;
    } catch (error) {
        services.logger.warn({ err: error }, "settings unreadable: threads of an automation are worked on one at a time");
        return 1;
    }
};

// One of the slots a thread's turn runs in, waited for in line once they are all working.
const takeSlot = async (services: Services, lanes: FireLanes, onWait: () => void): Promise<void> => {
    lanes.cap = await threadsAtOnce(services);
    // A raised setting lets in those already waiting first; only then is a slot left over for this fire.
    fillSlots(lanes);
    if (lanes.working < lanes.cap) {
        lanes.working += 1;
        return;
    }
    onWait();
    // Counted by fillSlots as it hands the slot over, so no fire arriving in between can take it.
    await new Promise<void>((resolve) => lanes.waiting.push(resolve));
};

const giveSlot = (lanes: FireLanes): void => {
    lanes.working -= 1;
    fillSlots(lanes);
};

// Fires one automation, taking its turn among the automation's other fires (FireLanes); owns only that and the overlap
// policy (refuse or wait), with `runFire` doing the fire itself. Callers run it detached; tests await it directly.
export const fireAutomation = async (services: Services, automation: AutomationRecord, options: FireOptions = {}): Promise<FireOutcome> => {
    const fireLanes = fireLanesOf.of(services);
    const lanes = fireLanes.get(automation.id) ?? openLanes();
    const shared = sharedConversationOf(options);
    // Whether this fire has to wait for one already admitted, decided now, before anything after it is admitted.
    const blocked = shared === undefined ? lanes.admitted > 0 : lanes.admittedAlone > 0 || lanes.conversations.has(shared);
    if (blocked && options.overlap !== "queue") {
        // Dropped as overlapping means no reply is coming; runFire's finally never runs here, so this closes the sink.
        options.stream?.failed("this automation is already running, so the message was not picked up");
        options.stream?.end();
        return {};
    }
    // Waiting is said where the message came from, once, so a quiet thread reads as queued rather than dead.
    let toldQueued = false;
    const tellQueued = (): void => {
        if (!toldQueued) {
            toldQueued = true;
            options.stream?.queued?.(QUEUED_NOTICE);
        }
    };
    if (blocked) {
        tellQueued();
    }
    const entry = options.admission ?? queuedFire(automation.id, mintConversationId(automation.id, Date.now()), options);
    // Durable before it waits, and only then is its source let go (durable/fire-admission.ts).
    const admitted = admitThenLetGo(services, automation.id, entry, options.accepted);
    const run = async (): Promise<FireOutcome> => {
        if (!(await admitted)) {
            options.stream?.failed("this message could not be taken in; it will be picked up again");
            options.stream?.end();
            return {};
        }
        return runFire(services, automation, { ...options, admission: entry });
    };
    // The lanes are the lock: what a fire waits for never rejects, so a failed fire still lets the next one start.
    const turn =
        shared === undefined
            ? lanes.all.then(run)
            : Promise.all([lanes.alone, lanes.conversations.get(shared)]).then(async () => {
                  await takeSlot(services, lanes, tellQueued);
                  try {
                      return await run();
                  } finally {
                      giveSlot(lanes);
                  }
              });
    const settled = turn.then(
        () => undefined,
        () => undefined,
    );
    lanes.admitted += 1;
    lanes.all = Promise.all([lanes.all, settled]).then(() => undefined);
    if (shared === undefined) {
        lanes.admittedAlone += 1;
        lanes.alone = settled;
    } else {
        lanes.conversations.set(shared, settled);
    }
    fireLanes.set(automation.id, lanes);
    void settled.then(() => {
        lanes.admitted -= 1;
        if (shared === undefined) {
            lanes.admittedAlone -= 1;
        } else if (lanes.conversations.get(shared) === settled) {
            // Only the last fire on a conversation clears it; an earlier one must not unlock a fire queued behind it.
            lanes.conversations.delete(shared);
        }
        if (lanes.admitted === 0 && fireLanes.get(automation.id) === lanes) {
            fireLanes.delete(automation.id);
        }
    });
    return turn;
};

// Waits until nothing of this automation is running or waiting, every thread's fire included. A recorded run isn't the
// same as free again, since a fire lets the next one go only when it returns; firing the same automation twice in a
// row must await this in between. A fire admitted while this waits is waited for too, until one wait finds nothing new.
// `daemon` narrows it to one daemon's fires (durable/daemon-memory.ts), for a test that runs a second beside a dead first.
export const automationIdle = async (id: string, daemon?: Pick<Services, "automations">): Promise<void> => {
    for (const fireLanes of daemon === undefined ? fireLanesOf.all() : [fireLanesOf.of(daemon)]) {
        let awaited: Promise<void> | undefined;
        for (let lanes = fireLanes.get(id); lanes !== undefined && lanes.all !== awaited; lanes = fireLanes.get(id)) {
            awaited = lanes.all;
            await awaited;
        }
    }
};

// Open the thread, fire on it, settle it: the one road every threaded fire takes (listeners, the public doors, a held
// wake's release, a restart's re-fire), so the thread learns the provider session the turn ran on and the next message
// resumes it instead of restating everything. `onOpened` hears the conversation before the turn starts.
export const fireOnThread = async (
    services: Services,
    automation: AutomationRecord,
    place: ThreadPlace,
    options: ThreadFireOptions,
    onOpened?: (conversationId: string) => Promise<void>,
): Promise<FireOutcome> => {
    const seat =
        "ttlMs" in place ? { key: place.key, ...(await services.threadSessions.open(place.key, place.mint, place.ttlMs, Date.now())) } : place;
    if (seat.conversationId !== undefined) {
        await onOpened?.(seat.conversationId);
    }
    const settled = await fireAutomation(services, automation, {
        ...options,
        ...(seat.conversationId !== undefined ? { conversationId: seat.conversationId } : {}),
        ...(seat.sessionId !== undefined ? { sessionId: seat.sessionId } : {}),
        // Snapshotted with a hold and journalled with the fire, so a later release or re-fire settles this same thread.
        ...(seat.key !== undefined ? { thread: seat.key } : {}),
    });
    if (seat.key !== undefined) {
        await services.threadSessions.settle(seat.key, settled.sessionId, Date.now());
    }
    return settled;
};

// The snapshot as fire options: each field absent rather than undefined, so replaying a hold cannot set one the
// original fire did not carry.
// The persona rides back as a lane so the approved run wears what was decided when it was held, not what the
// automation says now; the hold itself was answered, so the lane asks for none.
const heldWakeOptions = (held: AutomationApproval, sink: OutboxSink | undefined): ThreadFireOptions => ({
    overlap: "queue",
    cleared: "both",
    held: held.id,
    lane: { actsAs: held.actsAs, requireApproval: false },
    ...(held.payload !== undefined ? { payload: held.payload } : {}),
    ...(held.observed !== undefined ? { observed: held.observed } : {}),
    ...(held.origin !== undefined ? { origin: held.origin } : {}),
    ...(held.title !== undefined ? { title: held.title } : {}),
    ...(sink !== undefined ? { stream: sink.stream } : {}),
});

// Runs a held wake with its snapshot (`cleared: "both"`, guard already ran), then settles its thread so the next
// message resumes it. Shared by both releases, the approve route and the countdown scan; it takes only a hold one of them
// let out of the queue after checking its proof (held-wakes-store.ts, ReleasedWake).
export const runHeldWake = async (services: Services, automation: AutomationRecord, held: ReleasedWake): Promise<void> => {
    // The requester's own stream closed when the wake was held, so the answer has nowhere live to go: a Visitor chat's is
    // queued where their next page load collects it, a gateway channel's is posted into its thread once the turn ends.
    const sink = services.outboxStreamFor(held.origin) ?? channelAnswerSink(services, held.origin);
    // The snapshot carries the thread's own key: an origin cannot name it, since a thread is keyed by lane too.
    await fireOnThread(services, automation, { key: held.thread, conversationId: held.conversationId, sessionId: held.sessionId }, heldWakeOptions(held, sink));
    // Before the release is over: the approve route answers its caller here, and the visitor polling a moment later
    // must find the answer rather than an empty thread.
    await sink?.settled();
};

// The release store awaits this before deleting the hold or spending the owner's yes.
export const recordHeldWake = async (services: Services, held: ReleasedWake): Promise<void> => {
    await admitFire(services, queuedFire(held.automationId, mintConversationId(held.automationId, Date.now()), {
        ...heldWakeOptions(held, undefined), ...opt("conversationId", held.conversationId),
        ...opt("sessionId", held.sessionId), ...opt("thread", held.thread),
    }));
};
