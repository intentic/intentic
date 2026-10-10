import { type AgentSummary, type ConversationQueue, deriveTitle, type SandboxHandlerInput, type SandboxHandlerOutput } from "@intentic/sandbox-contract";
import { refuse } from "@intentic/contract-serve";
import { amendAgent, FEATURED_ID, roster } from "./roster";
import { startTurn } from "./turns";

// What waits for a conversation's next turn, as the daemon's queue holds it (conversation-queue.ts): messages booked to
// go by themselves, each at its own time or once another agent's work has landed, and the doors that send them sooner,
// re-time, reword or take them back. Kept on the card, as the daemon's roster carries it, so every surface reads one copy.
const NO_QUEUE: ConversationQueue = { items: [], revision: 0 };
type QueuedMessage = ConversationQueue[`items`][number];
type Hold = Pick<QueuedMessage, `until` | `after`>;
const queueOf = (id: string): ConversationQueue => roster.agents.find((agent) => agent.id === id)?.queue ?? NO_QUEUE;
const writeQueue = (id: string, queue: ConversationQueue): ConversationQueue => {
    amendAgent(id, ({ queue: _old, ...card }) => (queue.items.length === 0 && queue.revision === 0 ? card : { ...card, queue }));
    return queue;
};

// The queue's own fields as the daemon derives them from its messages: `scheduled` at the soonest booking (the earliest
// time, or the first agent waited for), for windows older than per-message bookings. Nothing here is held by a stop.
const queueFromMessages = (items: readonly QueuedMessage[], revision: number): ConversationQueue => {
    const instants = items.flatMap((item) => (item.until === undefined ? [] : [item.until]));
    if (instants.length > 0) {
        return { items: [...items], revision, paused: `scheduled`, until: Math.min(...instants) };
    }
    const after = items.find((item) => item.after !== undefined)?.after;
    return after === undefined ? { items: [...items], revision } : { items: [...items], revision, paused: `scheduled`, after };
};

// A message with this booking in place of the one it had.
const rebooked = (item: QueuedMessage, hold: Hold): QueuedMessage => {
    const { until: _until, after: _after, ...rest } = item;
    return { ...rest, ...hold };
};

// A booking's hold, or nothing when what it would wait for has already come: a time past, or an agent with nothing
// running and nothing left to land (work-landed.ts, read here off its card).
const holdOf = (booking: { readonly sendAt?: number | undefined; readonly sendAfter?: string | undefined }): Hold | undefined => {
    if (booking.sendAfter !== undefined) {
        const awaited = roster.agents.find((agent) => agent.id === booking.sendAfter);
        const done =
            awaited === undefined || ((awaited.status === `landed` || awaited.status === `idle`) && (awaited.queue?.items.length ?? 0) === 0);
        return done ? undefined : { after: booking.sendAfter };
    }
    return booking.sendAt === undefined || booking.sendAt <= Date.now() ? undefined : { until: booking.sendAt };
};

// One timer per booked message: the daemon's resume pass, for a page that is open for minutes rather than days.
const bookingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const LONGEST_TIMER_MS = 2 ** 31 - 1;
const timerKey = (id: string, messageId: string): string => `${id} ${messageId}`;
const armBooking = (id: string, messageId: string, until: number | undefined): void => {
    const key = timerKey(id, messageId);
    clearTimeout(bookingTimers.get(key));
    bookingTimers.delete(key);
    if (until !== undefined) {
        bookingTimers.set(
            key,
            setTimeout(() => letGo(id, [messageId]), Math.min(Math.max(0, until - Date.now()), LONGEST_TIMER_MS)),
        );
    }
};

// The messages named (every one, when none are) go out as one turn, the words joined as the daemon joins them; every
// other keeps its own booking. The run it started, if anything went.
const letGo = (id: string, ids?: readonly string[]): string | undefined => {
    const queue = queueOf(id);
    const going = queue.items.filter((item) => ids === undefined || ids.includes(item.id));
    for (const item of going) {
        armBooking(id, item.id, undefined);
    }
    if (going.length === 0) {
        return undefined;
    }
    writeQueue(
        id,
        queueFromMessages(
            queue.items.filter((item) => !going.includes(item)),
            queue.revision + 1,
        ),
    );
    return startTurn({ conversationId: id, prompt: going.map((item) => item.text).join(`\n\n`) }).run;
};

// The card a booked first message opens, as the daemon's registry writes one before any turn runs: idle, on its own
// branch, titled after its words, with the landing answer it opened with.
const bookedCard = (input: SandboxHandlerInput<`agent`, `run`>, id: string, now: number): AgentSummary => {
    const card: AgentSummary = {
        id,
        title: deriveTitle(input.prompt),
        status: `idle`,
        provider: input.agent ?? `claude`,
        harness: input.harness ?? `native`,
        updatedAt: now,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    };
    if (input.model !== undefined) {
        card.model = input.model;
    }
    if (input.isolated === true) {
        card.branch = `agent/${id}`;
    }
    if (input.conversationAutoLand !== undefined) {
        card.autoLand = input.conversationAutoLand;
    }
    return card;
};

// A message booked for later: it joins the queue on its own booking, every other keeping its own, opening the
// conversation's card when this is its first message. Nothing starts.
const book = (input: SandboxHandlerInput<`agent`, `run`>, id: string, hold: Hold) => {
    const now = Date.now();
    if (!roster.agents.some((agent) => agent.id === id)) {
        roster.agents = [bookedCard(input, id, now), ...roster.agents];
    }
    const queue = queueOf(id);
    const item: QueuedMessage = {
        id: input.messageId ?? crypto.randomUUID(),
        text: input.prompt,
        voice: `person`,
        queuedAt: now,
        revision: queue.revision + 1,
        ...hold,
    };
    writeQueue(id, queueFromMessages([...queue.items, item], item.revision));
    armBooking(id, item.id, hold.until);
    return { delivered: `queued` as const };
};

export const sayOrBook = (input: SandboxHandlerInput<`agent`, `run`>): { delivered: `started`; run: string } | { delivered: `queued` } => {
    const id = input.conversationId ?? FEATURED_ID;
    const hold = holdOf(input);
    return hold === undefined ? startTurn(input) : book(input, id, hold);
};

// The queue's four doors, each refused as the daemon refuses it: nothing waiting, a message named that has gone, or one
// changed since it was read. Re-timing and letting go act on the messages named, or on every one when none are.
export const queueDoors = {
    queueSchedule: ({ conversationId, sendAt, sendAfter, ids }: SandboxHandlerInput<`agent`, `queueSchedule`>): ConversationQueue => {
        const queue = queueOf(conversationId);
        if (queue.items.length === 0 || (ids ?? []).some((id) => !queue.items.some((item) => item.id === id))) {
            return refuse(`Nothing you named waits in that conversation's queue to schedule.`, 404);
        }
        const hold = holdOf({ sendAt, sendAfter });
        if (hold === undefined) {
            letGo(conversationId, ids);
            return queueOf(conversationId);
        }
        const named = (item: QueuedMessage): boolean => ids === undefined || ids.includes(item.id);
        for (const item of queue.items.filter(named)) {
            armBooking(conversationId, item.id, hold.until);
        }
        return writeQueue(
            conversationId,
            queueFromMessages(
                queue.items.map((item) => (named(item) ? rebooked(item, hold) : item)),
                queue.revision + 1,
            ),
        );
    },
    queueResume: ({ conversationId, ids }: SandboxHandlerInput<`agent`, `queueResume`>): SandboxHandlerOutput<`agent`, `queueResume`> => {
        const run = letGo(conversationId, ids);
        const answer: SandboxHandlerOutput<`agent`, `queueResume`> = { queue: queueOf(conversationId) };
        if (run !== undefined) {
            answer.run = run;
        }
        return answer;
    },
    queueRemove: ({ conversationId, id, revision }: SandboxHandlerInput<`agent`, `queueRemove`>): ConversationQueue => {
        const queue = queueOf(conversationId);
        const item = queue.items.find((waiting) => waiting.id === id) ?? refuse(`That message is no longer waiting.`, 404);
        if (item.revision !== revision) {
            return refuse(`That message was changed since you read it.`, 412);
        }
        armBooking(conversationId, id, undefined);
        return writeQueue(
            conversationId,
            queueFromMessages(
                queue.items.filter((waiting) => waiting !== item),
                queue.revision + 1,
            ),
        );
    },
    queueEdit: ({ conversationId, id, revision, text }: SandboxHandlerInput<`agent`, `queueEdit`>): ConversationQueue => {
        const queue = queueOf(conversationId);
        const item = queue.items.find((waiting) => waiting.id === id) ?? refuse(`That message is no longer waiting.`, 404);
        if (item.revision !== revision) {
            return refuse(`That message was changed since you read it.`, 412);
        }
        const next = queue.revision + 1;
        return writeQueue(conversationId, {
            ...queue,
            items: queue.items.map((waiting) => (waiting === item ? { ...waiting, text, revision: next } : waiting)),
            revision: next,
        });
    },
};

// What waited on an agent's land goes once that land is in: the messages booked for it, and no other.
export const releaseAfter = (landed: string): void => {
    for (const agent of roster.agents) {
        const ids = (agent.queue?.items ?? []).filter((item) => item.after === landed).map((item) => item.id);
        if (ids.length > 0) {
            letGo(agent.id, ids);
        }
    }
};
