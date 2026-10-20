import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { ConversationQueue } from "@intentic/sandbox-contract/schemas/agent";
import { deriveTitle } from "@intentic/sandbox-contract/text/title";
import type { SandboxHandlerInput, SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { amendAgent, broadcastRoster, FEATURED_ID, roster } from "./roster";
import { startTurn } from "./turns";

// What waits for a conversation's next turn, as the daemon's queue holds it (conversation-queue.ts): messages booked to
// go by themselves, each at its own time or once another agent's work has landed, and the doors that send them sooner,
// re-time, reword or take them back. Kept on the card, as the daemon's roster carries it, so every surface reads one copy.
const NO_QUEUE: ConversationQueue = { items: [], revision: 0 };
type QueuedMessage = ConversationQueue[`items`][number];
type Hold = Pick<QueuedMessage, `until` | `after` | `reopenOf`>;
type Serving = NonNullable<QueuedMessage[`serves`]>;
const queueOf = (id: string): ConversationQueue => roster.agents.find((agent) => agent.id === id)?.queue ?? NO_QUEUE;
// What the bookings carry the card on by, as the daemon derives its `next` from them (conversation-next.ts): the soonest
// time, else the first land waited for. The demo holds no turn or memory hold a booking would rank behind.
const bookedNext = (queue: ConversationQueue): AgentSummary[`next`] => {
    const booked = queue.items.filter((item) => item.until !== undefined || item.after !== undefined);
    const instants = booked.flatMap((item) => (item.until === undefined ? [] : [item.until]));
    const after = booked.find((item) => item.after !== undefined)?.after;
    if (instants.length > 0) {
        return { kind: `send`, at: Math.min(...instants), count: booked.length };
    }
    return after === undefined ? undefined : { kind: `land`, after, count: booked.length };
};
const writeQueue = (id: string, queue: ConversationQueue): ConversationQueue => {
    amendAgent(id, ({ queue: _old, next: _was, ...card }) => {
        const next = bookedNext(queue);
        const kept = next === undefined ? card : { ...card, next };
        return queue.items.length === 0 && queue.revision === 0 ? kept : { ...kept, queue };
    });
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

// A message with this booking in place of the one it had; a new booking's reason replaces the old one's too.
const rebooked = (item: QueuedMessage, hold: Hold): QueuedMessage => {
    const { until: _until, after: _after, reopenOf: _reopenOf, ...rest } = item;
    return { ...rest, ...hold };
};

// Who a person's words go on, as their request names them (conversation-queue.ts servingOf): the card's own where the
// request names none.
const servingOf = (id: string, input: { readonly agent?: string | undefined; readonly harness?: Serving[`harness`] | undefined; readonly model?: string | undefined; readonly effort?: string | undefined; readonly account?: string | undefined }): Serving => {
    const card = roster.agents.find((agent) => agent.id === id);
    const serving: Serving = { agent: input.agent ?? card?.provider ?? `claude`, harness: input.harness ?? `native` };
    const model = input.model ?? card?.model;
    if (model !== undefined && model !== ``) {
        serving.model = model;
    }
    if (input.effort !== undefined) {
        serving.effort = input.effort;
    }
    const account = input.account ?? (serving.agent === card?.provider ? card.account : undefined);
    if (account !== undefined) {
        serving.account = account;
    }
    return serving;
};

// The allowance an instant booked for a reopen waits out (booking-ask.ts): the account the words go on.
const reopenOfServing = (serving: Serving | undefined): QueuedMessage[`reopenOf`] =>
    serving === undefined ? undefined : serving.account === undefined ? { agent: serving.agent } : { agent: serving.agent, account: serving.account };

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
    const serves = servingOf(id, input);
    const item: QueuedMessage = {
        id: input.messageId ?? crypto.randomUUID(),
        text: input.prompt,
        voice: `person`,
        queuedAt: now,
        revision: queue.revision + 1,
        serves,
        ...hold,
    };
    if (input.sendAtReopen === true && hold.until !== undefined) {
        item.reopenOf = reopenOfServing(serves);
    }
    writeQueue(id, queueFromMessages([...queue.items, item], item.revision));
    armBooking(id, item.id, hold.until);
    return { delivered: `queued` as const };
};

export const sayOrBook = (input: SandboxHandlerInput<`agent`, `run`>): { delivered: `started`; run: string } | { delivered: `queued` } => {
    const id = input.conversationId ?? FEATURED_ID;
    const hold = holdOf(input);
    if (hold !== undefined) {
        return book(input, id, hold);
    }
    // A conversation's first message opens its card, as the daemon's registry does: without this a fresh board (mode.ts
    // `freshEdition`) could never show its first agent arriving.
    if (!roster.agents.some((agent) => agent.id === id)) {
        roster.agents = [bookedCard(input, id, Date.now()), ...roster.agents];
    }
    return startTurn({ ...input, conversationId: id });
};

// A conversation that exists only for the message just taken back: no turn ran in it, no session, nothing else waits, and
// no booking elsewhere waits on its land. Forgotten here, as the daemon forgets its entry.
const unopened = (id: string, left: ConversationQueue): boolean => {
    const card = roster.agents.find((agent) => agent.id === id);
    if (
        card === undefined ||
        left.items.length > 0 ||
        (card.turns ?? 0) > 0 ||
        card.sessionId !== undefined ||
        roster.agents.some((agent) => (agent.queue?.items ?? []).some((waiting) => waiting.after === id))
    ) {
        return false;
    }
    roster.agents = roster.agents.filter((agent) => agent.id !== id);
    broadcastRoster();
    return true;
};

// The queue's four doors, each refused as the daemon refuses it: nothing waiting, a message named that has gone, or one
// changed since it was read. Re-timing and letting go act on the messages named, or on every one when none are.
export const queueDoors = {
    queueSchedule: ({ conversationId, sendAt, sendAfter, sendAtReopen, ids }: SandboxHandlerInput<`agent`, `queueSchedule`>): ConversationQueue => {
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
        // A reopen is waited out where the words go: the newest person's among them.
        const reopenOf = sendAtReopen === true && hold.until !== undefined ? reopenOfServing(queue.items.filter(named).findLast((item) => item.voice === `person`)?.serves) : undefined;
        const booked: Hold = reopenOf === undefined ? hold : { ...hold, reopenOf };
        return writeQueue(
            conversationId,
            queueFromMessages(
                queue.items.map((item) => (named(item) ? rebooked(item, booked) : item)),
                queue.revision + 1,
            ),
        );
    },
    // A person's waiting words pointed at another pick, letting nothing go (conversation-queue.ts rerouted): a model or
    // effort left out keeps each one's own, an account left out goes on the conversation's own.
    queueReroute: ({ conversationId, routing, ids }: SandboxHandlerInput<`agent`, `queueReroute`>): ConversationQueue => {
        const queue = queueOf(conversationId);
        if (queue.items.length === 0) {
            return refuse(`Nothing waits in that conversation's queue to move.`, 404);
        }
        const next = queue.revision + 1;
        const moved = (item: QueuedMessage): QueuedMessage => {
            if (item.voice !== `person` || item.serves === undefined || (ids !== undefined && !ids.includes(item.id))) {
                return item;
            }
            const serves: Serving = { agent: routing.agent, harness: routing.harness };
            const model = routing.model ?? item.serves.model;
            const effort = routing.effort ?? item.serves.effort;
            if (model !== undefined) {
                serves.model = model;
            }
            if (effort !== undefined) {
                serves.effort = effort;
            }
            if (routing.account !== undefined) {
                serves.account = routing.account;
            }
            return { ...item, serves, revision: next };
        };
        return writeQueue(conversationId, { ...queue, items: queue.items.map(moved), revision: next });
    },
    queueResume: ({ conversationId, ids }: SandboxHandlerInput<`agent`, `queueResume`>): SandboxHandlerOutput<`agent`, `queueResume`> => {
        const run = letGo(conversationId, ids);
        const answer: SandboxHandlerOutput<`agent`, `queueResume`> = { queue: queueOf(conversationId) };
        if (run !== undefined) {
            answer.run = run;
        }
        return answer;
    },
    // Taking back the message that opened its conversation, with nothing else in it since, takes the conversation too,
    // as the daemon's turn-admission does (`unopened`): its card leaves the board and the answer says so.
    queueRemove: ({ conversationId, id, revision }: SandboxHandlerInput<`agent`, `queueRemove`>): SandboxHandlerOutput<`agent`, `queueRemove`> => {
        const queue = queueOf(conversationId);
        const item = queue.items.find((waiting) => waiting.id === id) ?? refuse(`That message is no longer waiting.`, 404);
        if (item.revision !== revision) {
            return refuse(`That message was changed since you read it.`, 412);
        }
        armBooking(conversationId, id, undefined);
        const left = writeQueue(
            conversationId,
            queueFromMessages(
                queue.items.filter((waiting) => waiting !== item),
                queue.revision + 1,
            ),
        );
        return unopened(conversationId, left) ? { ...left, unopened: true } : left;
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

// A conversation moved to another of its provider's accounts (switch-account.ts): its card runs there from now on, and
// so does every person's word waiting in its queue, held or booked, each keeping its own model (queue-rerouted).
export const switchAccount = ({ conversationId, account }: SandboxHandlerInput<`agent`, `switchAccount`>): SandboxHandlerOutput<`agent`, `switchAccount`> => {
    if (!roster.agents.some((agent) => agent.id === conversationId)) {
        return refuse(`No such conversation to move.`, 404);
    }
    amendAgent(conversationId, (card) => ({ ...card, account }));
    const queue = queueOf(conversationId);
    if (queue.items.some((item) => item.voice === `person` && item.serves !== undefined && item.serves.account !== account)) {
        const next = queue.revision + 1;
        const moved = (item: QueuedMessage): QueuedMessage =>
            item.voice === `person` && item.serves !== undefined ? { ...item, serves: { ...item.serves, account }, revision: next } : item;
        writeQueue(conversationId, { ...queue, items: queue.items.map(moved), revision: next });
    }
    return {};
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
