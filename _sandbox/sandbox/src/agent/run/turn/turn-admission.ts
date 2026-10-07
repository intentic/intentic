import { routingFor } from "../../providers/accounts/routing.js";
import { randomUUID } from "node:crypto";
import { keyedLock } from "@intentic/base/async";
import { MENTION_LIMIT, type MessageReceipt, profileOf, withRuntimeDefaults } from "@intentic/sandbox-contract";
import type { BeginRefusal, BeginTurn } from "../../../conversations/actor/conversation-decide.js";
import { type LiveRun, liveRunOf, turnRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { type Booking, holdOf, type QueuedItem, waitingOf } from "../../../conversations/actor/conversation-queue.js";
import { windowShut } from "../../../conversations/actor/conversation-state.js";
import { cardsParkedOn } from "../../../conversations/actor/parked-cards.js";
import { unwaitable, workLanded } from "../../../conversations/land/work-landed.js";
import { conversationProfile, worktreeOf } from "../../../conversations/registry/agents-store.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { Said, Steer, TurnInput, TurnStarter, Unsaid, Unsteered } from "../../../seams/turn-starter.js";
import { conversationIdentity, unpairedRunner } from "../placement/turn-placement.js";
import { recordConversationPrompt, recordPrompt } from "../../../sessions/transcript-search.js";
import { checkpointSteeredMessage } from "../../checkpoints/steer-checkpoints.js";
import { keepReceipt, receiptOf } from "./message-receipts.js";
import { steerComposed } from "./turn-interactions.js";

// Every message to a conversation comes through here, whoever sends it: said into the live turn where that turn takes
// words, started as a turn of its own when nothing runs, and otherwise queued on the conversation's actor until one of
// those can happen. Answered with what became of it, which the same message id sent again gets back instead of a second
// delivery. One piece of work at a time per conversation, so a message, its resend and a drain never decide at once.

type Turn = TurnInput & { readonly conversationId: string };

// A person's words for the live turn, and the id that names them.
type PersonSteer = Omit<Steer, "voice" | "outside">;

const NOT_STEERABLE: Unsteered = { why: "no steerable turn running for that conversation" };

// A local steer's answer as admission gives it: a turn that took no words is said why.
const steeredOr = (steered: boolean | { readonly invalid: string }): true | Unsteered => (steered === false ? NOT_STEERABLE : steered);

const ARCHIVED: Unsaid = { why: "the conversation is archived, and only a person's message reopens it" };

// Hands the words to the live turn wherever it runs: composed against this workspace for a local one, uncomposed to a
// runner's, whose paths resolve only in its own workspace.
const handOver = async (services: Services, conversationId: string, steer: PersonSteer): Promise<true | Unsteered> => {
    const runnerId = worktreeOf(services.agents.entry(conversationId))?.runner;
    if (runnerId === undefined) {
        return steeredOr(await steerComposed(services, conversationId, { ...steer, voice: "person" }));
    }
    const client = services.runnerHub.client(runnerId);
    if (client === undefined) {
        return { why: `the runner "${runnerId}" is offline, so nothing is running to say this to.` };
    }
    const delivered = await client.steer({
        conversationId,
        text: steer.text,
        attachments: steer.attachments?.slice(),
        mentions: steer.mentions?.slice(),
        editorContext: steer.editorContext,
    });
    if (delivered.invalid !== undefined) {
        return { invalid: delivered.invalid };
    }
    return delivered.applied || NOT_STEERABLE;
};

/** A person's words into the live turn: drawn as their row, its rewind slot reserved, and filed for search. */
export const steerPerson = async (services: Services, conversationId: string, steer: PersonSteer): Promise<true | Unsteered> => {
    const handed = await handOver(services, conversationId, steer);
    if (handed !== true) {
        return handed;
    }
    // Pushed synchronously, after the turn took the words and before anything answers.
    turnRunOf(services.conversations, conversationId)?.push({
        kind: "steer",
        text: steer.text,
        sentAt: Date.now(),
        messageId: steer.messageId ?? randomUUID(),
        ...((steer.attachments ?? []).length > 0 ? { attachments: [...(steer.attachments ?? [])] } : {}),
    });
    // Reserves this steer's rewind slot in the same synchronous breath as the frame.
    await checkpointSteeredMessage(services, conversationId);
    // Indexed here, since the prompt index reads a session file once and would miss this.
    const sessionId = services.conversations.sessionIdOf(conversationId);
    recordConversationPrompt(conversationId, steer.text);
    if (sessionId !== undefined) {
        recordPrompt(sessionId, steer.text);
    }
    return true;
};

// The message as the queue keeps it, named: a sender that gave no id gets one, since the queue and a rewind name it.
const named = (said: Said): Omit<QueuedItem, "revision"> => {
    // The booking is the admission's to act on (bookingFor), never a field the started turn carries.
    const { actor, owner, areas, unseenRuns: _unseen, speaker, sendAt: _at, sendAfter: _after, ...turn } = said.turn;
    const id = turn.messageId ?? randomUUID();
    return {
        id,
        voice: said.voice,
        ...opt("actor", actor),
        // The sandbox's own words are the sandbox's whoever queued them, so the row they open never reads as the owner's.
        ...opt("speaker", speaker ?? (said.voice === "sandbox" ? { kind: "sandbox" as const } : undefined)),
        ...opt("owner", owner),
        ...opt("areas", areas),
        ...opt("outside", said.outside),
        queuedAt: Date.now(),
        turn: { ...turn, messageId: id },
    };
};

// The request a queued message makes, with whoever sent it attributed again, and the taint its outside words carry.
const requestOf = (item: Omit<QueuedItem, "revision">): Turn => ({
    ...item.turn,
    ...opt("speaker", item.speaker),
    ...opt("actor", item.actor),
    ...opt("owner", item.owner),
    ...opt("areas", item.areas),
    ...opt("outsideWake", item.outside),
});

// A wake (a watch's report, a finished background job, a child's report, a land follow-up) continues the conversation as
// it runs when the wake goes out, never as it ran when the wake was armed or queued: the routing it captured then goes
// stale the moment the conversation moves, and replaying it would put the current session on an account, runtime or
// model nobody chose. Only who serves the turn is replaced; its persona, placement, audience and job stay the wake's.
// The account is left unnamed: routingFor fills in the conversation's own, and a wake naming none is routed off that
// account where it can no longer serve (blocked-account.ts), as a person's next message is; naming it would pin it.
const onCurrentRouting = (services: Services, turn: Turn): Turn => {
    const entry = services.agents.entry(turn.conversationId);
    if (entry === undefined) {
        return turn;
    }
    const { agent: _agent, harness: _harness, account: _account, model: _model, effort: _effort, thinking: _thinking, fast: _fast, ...own } = turn;
    const { agent, harness, model, effort, thinking, fast } = conversationProfile(entry);
    return { ...own, ...profileOf({ agent, harness, model, effort, thinking, fast }) };
};

// What goes before anything waiting: a recovery the daemon runs by itself, or a rewind restoring files.
const goesFirst = (services: Services, conversationId: string): boolean => {
    const state = services.conversations.state(conversationId);
    return state?.turn.resuming === true || state?.phase.kind === "rewinding";
};

// Whether words nobody at the composer typed must wait rather than open a turn: the conversation is stranded behind a
// spent allowance whose window is known to be shut. A turn opened there is refused at the door within seconds, and the
// refusal takes the held turn's place, so the press or the booked resend would then re-run a wake instead of the work,
// on a fresh session. They wait in the queue and go with the conversation's next turn, or once the window reopens
// (turn-resume.ts drains them then). A live turn still takes them, and a person's words are never held here: sending is
// the person's own call.
const heldBehindLimit = (services: Services, conversationId: string, voices: readonly QueuedItem["voice"][]): boolean =>
    voices.every((voice) => voice !== "person") && windowShut(services.conversations.state(conversationId)?.resume.held, Date.now());

// How far ahead a scheduled send may be booked. A time somebody chose is an appointment, and a month holds every one
// worth keeping (a spent allowance reopens within a week); past it a booking is a slip, a year typed for a day.
const LONGEST_BOOKING_MS = 31 * 24 * 60 * 60 * 1000;

// What a scheduled send asks to wait for, as its fields name it: an instant, or another conversation's work; and which
// conversation is asking.
interface BookingAsk {
    readonly conversationId: string;
    readonly sendAt?: number | undefined;
    readonly sendAfter?: string | undefined;
}

/**
 * The booking a scheduled send waits by, undefined when there is nothing left to wait for (an instant already past, a
 * conversation whose work is all in the workspace already: it goes now, the ordinary way), or why it cannot wait (the
 * conversation it names cannot land anything). Clamped, not refused: the person asked for it to wait, and a month is the
 * longest wait there is. A turn running here, or a recovery going first, books it all the same: the person chose when it
 * goes, and a turn ending is not that moment.
 */
const bookingOfAsk = (services: Services, ask: BookingAsk, now: number): Booking | undefined | Unsaid => {
    if (ask.sendAfter !== undefined) {
        const why = unwaitable(services, ask.sendAfter, ask.conversationId);
        if (why !== undefined) {
            return { invalid: why };
        }
        return workLanded(services, ask.sendAfter, now) ? undefined : { after: { conversationId: ask.sendAfter, since: now } };
    }
    return ask.sendAt === undefined || ask.sendAt <= now ? undefined : { until: Math.min(ask.sendAt, now + LONGEST_BOOKING_MS) };
};

// A person's words only: the sandbox's and an agent's never wait on a clock somebody set.
const bookingFor = (services: Services, said: Said, now: number): Booking | undefined | Unsaid =>
    said.voice === "person" ? bookingOfAsk(services, said.turn, now) : undefined;

const unbookable = (booking: Booking | Unsaid | undefined): booking is Unsaid => booking !== undefined && ("invalid" in booking || "why" in booking);

/**
 * The opening a scheduled send writes for a conversation it opens: what that conversation's first turn would record at
 * its `begin` (stream-agent.ts, runConversationTurn), from the same request, so the card is on the board and the booking
 * survives a restart, and the turn that runs later finds its placement already decided. A runner nobody paired refuses
 * here as it would there, rather than at a moment nobody is watching.
 */
const openingOf = async (services: Services, turn: Turn): Promise<BeginTurn | Unsaid> => {
    const routed = withRuntimeDefaults(turn);
    const runner = routed.placement?.kind === "runner" ? routed.placement.id : undefined;
    if (runner !== undefined && !(await services.runners.enrolled(runner))) {
        return { invalid: unpairedRunner(runner) };
    }
    return conversationIdentity(routed, turn.conversationId, { isolated: runner !== undefined || routed.isolated === true, runner });
};

// Whether the live turn takes words now: not being stopped, and not parked on a card, whose answer comes first.
const takesWords = (services: Services, conversationId: string): boolean => {
    const phase = services.conversations.state(conversationId)?.phase;
    return phase?.kind === "running" && phase.stopping === undefined && cardsParkedOn(services.conversations, conversationId) === 0;
};

// Said into the live turn: a person's through their own door (row, rewind slot, search), the sandbox's and an agent's
// through the one every wake takes, which frames them as the turn's own notice.
const steerItem = async (services: Services, item: Omit<QueuedItem, "revision">): Promise<true | Unsteered> => {
    const { conversationId, prompt, attachments, mentions, editorContext } = item.turn;
    const words: PersonSteer = { text: prompt, messageId: item.id, attachments, mentions, editorContext };
    if (item.voice === "person") {
        return steerPerson(services, conversationId, words);
    }
    const steer = { ...words, voice: item.voice, ...opt("outside", item.outside), ...opt("errand", item.turn.errand) };
    return steeredOr(await steerComposed(services, conversationId, steer));
};

// Messages that go out as one turn: one person's in a row, joined as the composer always joined them; anything else
// alone, since the sandbox's own words stand as a card of their own. Never two senders: a turn has one owner and fence.
export const together = (items: readonly QueuedItem[]): readonly QueuedItem[] => {
    const first = items[0];
    if (first === undefined || first.voice !== "person") {
        return items.slice(0, 1);
    }
    const end = items.findIndex((item) => item.voice !== "person" || item.actor !== first.actor);
    return items.slice(0, end === -1 ? items.length : end);
};

// The session a person's turn goes on in, decided here and nowhere else: on a conversation the daemon holds, its own
// session, only on the runtime and account that minted it, by the one routing rule (agent/providers/accounts/routing.ts).
// A `sessionId` a client sent is no say in it; an older editor sends one it worked out itself, which this ignores. Only
// a conversation not on record yet takes the one it names: a past session resumed from the history menu has no record.
export const sessionFor = (services: Pick<Services, "agents" | "conversations">, routing: Pick<Turn, "conversationId" | "agent" | "harness" | "account" | "sessionId">): string | undefined => {
    const entry = services.agents.entry(routing.conversationId);
    if (entry === undefined) {
        return routing.sessionId;
    }
    return routingFor(entry.profile, routing).continues ? services.conversations.sessionIdOf(routing.conversationId) : undefined;
};

// A person's turn as its sender asked for it, but on the session the daemon decides (sessionFor), never one it was sent.
const personTurn = (services: Services, turn: Turn): Turn => {
    const { sessionId: _asked, ...rest } = turn;
    return { ...rest, ...opt("sessionId", sessionFor(services, turn)) };
};

// The turn a batch of waiting messages makes: the sandbox's alone on the session it continues; a person's words joined,
// their files together, on the newest sender's routing, which is the latest pick. Its opening row is the first message's.
const turnOf = (services: Services, batch: readonly QueuedItem[]): Turn => {
    const last = batch.at(-1) ?? batch[0];
    if (last === undefined || batch[0] === undefined) {
        throw new Error("a turn needs at least one message");
    }
    const { conversationId } = last.turn;
    if (last.voice !== "person") {
        const { sessionId: _asked, ...wake } = onCurrentRouting(services, requestOf(last));
        return { ...wake, ...opt("sessionId", services.conversations.sessionIdOf(conversationId)) };
    }
    const { prompt: _p, attachments: _a, mentions: _m, editorContext: _e, messageId: _i, sessionId: asked, ...routing } = requestOf(last);
    const attachments = batch.flatMap((item) => item.turn.attachments ?? []);
    const mentions = [...new Set(batch.flatMap((item) => item.turn.mentions ?? []))].filter((path) => !attachments.includes(path));
    const editorContext = batch.find((item) => item.turn.editorContext !== undefined)?.turn.editorContext;
    const session = sessionFor(services, { ...routing, sessionId: asked });
    return {
        ...routing,
        prompt: batch
            .map((item) => item.turn.prompt)
            .filter((text) => text.length > 0)
            .join("\n\n"),
        messageId: batch[0].id,
        ...(attachments.length > 0 ? { attachments } : {}),
        // Guesses read out of the words, so a batch past the limit loses the last of them rather than the turn.
        ...(mentions.length > 0 ? { mentions: mentions.slice(0, MENTION_LIMIT) } : {}),
        ...opt("editorContext", editorContext),
        ...opt("sessionId", session),
    };
};

// A person's turn in flight, with the messages it delivers: a refusal at the door hands them back to the queue.
interface Carrying {
    readonly run: LiveRun;
    readonly batch: readonly Omit<QueuedItem, "revision">[];
}

// `services` is read per call, since the port this serves is composed into the very object it reads.
export const createAdmission = (
    services: () => Services,
    start: TurnStarter["start"],
): Pick<TurnStarter, "say" | "steerIn" | "drain" | "unqueue" | "reword" | "release" | "reschedule"> => {
    // One piece of work per conversation at a time.
    const inTurn = keyedLock<string>();
    const carrying = new Map<string, readonly Carrying[]>();

    const kept = (conversationId: string, receipts: ReadonlyMap<string, MessageReceipt>): void => {
        for (const [messageId, receipt] of receipts) {
            keepReceipt(services().conversations, conversationId, messageId, receipt);
        }
    };

    // Starts the turn a batch makes, a person's only if its words are; a person's is watched until it settles, since a
    // refusal at the door hands its words back to the queue rather than the sandbox holding the turn.
    const startWith = async (batch: readonly Omit<QueuedItem, "revision">[], turn: Turn): Promise<string | BeginRefusal> => {
        const person = batch[0]?.voice === "person";
        const started = await start(turn, { senderKeeps: person });
        if (typeof started === "string") {
            return started;
        }
        const run = turnRunOf(services().conversations, turn.conversationId);
        if (person && run?.id === started.id && run !== undefined) {
            carrying.set(turn.conversationId, [...(carrying.get(turn.conversationId) ?? []), { run, batch }]);
        }
        return started.id;
    };

    // The sandbox's words a conversation archived since they were queued: dropped, since only a person reopens it.
    const dropArchived = (conversationId: string, batch: readonly QueuedItem[]): void => {
        const daemon = services();
        for (const item of batch) {
            daemon.conversations.send(conversationId, { kind: "queue-removed", id: item.id, revision: item.revision });
        }
        daemon.logger.info({ conversationId, messages: batch.length }, "admission: the conversation is archived, the sandbox's waiting words were dropped");
    };

    // Whether anything waiting may go out now: a hold keeps it, and so does a recovery the daemon runs by itself or a rewind
    // restoring files, either of which goes first. A booked message is not waiting: it goes at its own time (turn-resume.ts).
    const held = (conversationId: string): boolean => {
        const daemon = services();
        const queue = daemon.conversations.queued(conversationId);
        return waitingOf(queue).length === 0 || holdOf(queue) !== undefined || goesFirst(daemon, conversationId);
    };

    // The next of the queue out: its head said into the live turn where that turn takes words, else one turn of what rides
    // together. Booked messages stay where they are, for their own time. Answers what it delivered, by message id;
    // undefined when nothing could go.
    const step = async (conversationId: string): Promise<ReadonlyMap<string, MessageReceipt> | undefined> => {
        const daemon = services();
        const items = waitingOf(daemon.conversations.queued(conversationId));
        const [head] = items;
        const live = liveRunOf(daemon.conversations, conversationId);
        if (head === undefined) {
            return undefined;
        }
        if (live !== undefined || daemon.conversations.state(conversationId)?.phase.kind === "running") {
            if (!takesWords(daemon, conversationId) || (await steerItem(daemon, head)) !== true) {
                return undefined;
            }
            daemon.conversations.send(conversationId, { kind: "queue-taken", ids: [head.id] });
            return new Map([[head.id, { delivered: "steered", ...opt("run", live?.id) }]]);
        }
        if (heldBehindLimit(daemon, conversationId, items.map((item) => item.voice))) {
            return undefined;
        }
        const batch = together(items);
        const person = batch[0]?.voice === "person";
        let run = await startWith(batch, turnOf(daemon, batch));
        // A person's words reopen an archived conversation, as they did at the door they were sent through: one booked
        // for later was archived since (the aged sweep, an older editor), and its time is that person's say-so too.
        if (run === "archived" && person) {
            await daemon.agents.clearArchived([conversationId]);
            run = await startWith(batch, turnOf(daemon, batch));
        }
        if (run === "archived") {
            // Never a person's words: they stay in the queue, for whoever opens the conversation to find.
            if (person) {
                daemon.logger.warn({ conversationId, messages: batch.length }, "admission: the conversation stays archived, a person's waiting words were kept");
                return undefined;
            }
            dropArchived(conversationId, batch);
            return new Map();
        }
        if (run === "busy") {
            return undefined;
        }
        daemon.conversations.send(conversationId, { kind: "queue-taken", ids: batch.map((item) => item.id) });
        return new Map(batch.map((item) => [item.id, { delivered: "started", run }]));
    };

    // Everything of the queue that can go out now, by message id.
    const deliver = async (conversationId: string): Promise<Map<string, MessageReceipt>> => {
        const delivered = new Map<string, MessageReceipt>();
        while (!held(conversationId)) {
            const stepped = await step(conversationId);
            if (stepped === undefined) {
                break;
            }
            for (const [messageId, receipt] of stepped) {
                delivered.set(messageId, receipt);
            }
        }
        return delivered;
    };

    // A message said into the live turn, when it takes words now; undefined when it has to wait.
    const intoLive = async (item: Omit<QueuedItem, "revision">, live: LiveRun | undefined): Promise<MessageReceipt | Unsaid | undefined> => {
        const daemon = services();
        if (!takesWords(daemon, item.turn.conversationId)) {
            return undefined;
        }
        const steered = await steerItem(daemon, item);
        if (steered === true) {
            return { delivered: "steered", ...opt("run", live?.id) };
        }
        return "invalid" in steered ? steered : undefined;
    };

    // Where a message goes when nothing waits ahead of it: into the live turn where it takes words, a turn of its own when
    // nothing runs; undefined when it has to wait, `Unsaid` when it can go nowhere.
    const deliverNow = async (item: Omit<QueuedItem, "revision">): Promise<MessageReceipt | Unsaid | undefined> => {
        const daemon = services();
        const { conversationId } = item.turn;
        if (goesFirst(daemon, conversationId)) {
            return undefined;
        }
        const live = liveRunOf(daemon.conversations, conversationId);
        if (live !== undefined || daemon.conversations.state(conversationId)?.phase.kind === "running") {
            return intoLive(item, live);
        }
        if (heldBehindLimit(daemon, conversationId, [item.voice])) {
            return undefined;
        }
        // Its own turn, as its sender asked for it, on the session the daemon says it continues; a wake on the routing
        // the conversation has now.
        const request = requestOf(item);
        const run = await startWith([item], item.voice === "person" ? personTurn(daemon, request) : onCurrentRouting(daemon, request));
        if (run === "archived") {
            return ARCHIVED;
        }
        return run === "busy" ? undefined : { delivered: "started", run };
    };

    // A message nothing waits ahead of goes straight where it can; any other joins the queue, which then lets out what it
    // can, this message among it or not. The sandbox's words for an archived conversation join nothing.
    const admit = async (item: Omit<QueuedItem, "revision">): Promise<MessageReceipt | Unsaid> => {
        const { conversationId } = item.turn;
        if (services().conversations.archived(conversationId)) {
            services().logger.info({ conversationId, voice: item.voice }, "admission: the conversation is archived, the sandbox's words go nowhere");
            return ARCHIVED;
        }
        // Only a booked message waiting is nothing ahead of this one: it goes at its own time, and this one now.
        const queue = services().conversations.queued(conversationId);
        const now = waitingOf(queue).length === 0 && holdOf(queue) === undefined ? await deliverNow(item) : undefined;
        if (now !== undefined) {
            return now;
        }
        services().conversations.send(conversationId, { kind: "queue-joined", item });
        const delivered = await deliver(conversationId);
        kept(conversationId, delivered);
        return delivered.get(item.id) ?? { delivered: "queued" };
    };

    // What became of this message the first time, when the conversation already took one under its id.
    const duplicate = async (conversationId: string, messageId: string | undefined): Promise<MessageReceipt | undefined> => {
        const earlier = messageId === undefined ? undefined : await receiptOf(services(), conversationId, messageId);
        return earlier === undefined ? undefined : { ...earlier, duplicate: true };
    };

    // A person's words a refusal at the door turned away go back to the head of the queue, held, for everyone to see.
    const handBack = (conversationId: string): void => {
        const daemon = services();
        const all = carrying.get(conversationId) ?? [];
        const still = all.filter(({ run }) => !run.done);
        if (still.length === 0) {
            carrying.delete(conversationId);
        } else {
            carrying.set(conversationId, still);
        }
        for (const { run, batch } of all.filter((carried) => carried.run.done && carried.run.ranNothing)) {
            daemon.conversations.send(conversationId, { kind: "queue-returned", items: batch });
            kept(conversationId, new Map(batch.map((item) => [item.id, { delivered: "queued" } as const])));
            daemon.logger.info({ conversationId, run: run.id, messages: batch.length }, "admission: a refusal at the door handed the words back to the queue");
        }
    };

    // Books the message by its own booking, every other waiting message left as it was, opening the conversation's entry
    // when this message is the first it gets, so the card and the queue are on record from the press.
    const book = async (item: Omit<QueuedItem, "revision">, booking: Booking): Promise<MessageReceipt | Unsaid> => {
        const daemon = services();
        const { conversationId } = item.turn;
        const opening = daemon.agents.entry(conversationId) === undefined ? await openingOf(daemon, requestOf(item)) : undefined;
        if (opening !== undefined && !("conversationId" in opening)) {
            return opening;
        }
        await daemon.conversations.send(conversationId, { kind: "queue-scheduled", item, booking, ...opt("opening", opening) }).settled;
        const booked: MessageReceipt = { delivered: "queued" };
        kept(conversationId, new Map([[item.id, booked]]));
        daemon.logger.info({ conversationId, until: booking.until, after: booking.after?.conversationId }, "admission: a scheduled send is booked");
        return booked;
    };

    return {
        say: (said) =>
            inTurn(said.turn.conversationId, async () => {
                const { conversationId, messageId } = said.turn;
                const earlier = await duplicate(conversationId, messageId);
                if (earlier !== undefined) {
                    return earlier;
                }
                const item = named(said);
                // A scheduled send is booked, not delivered: it waits in the queue, where every window draws it as
                // scheduled, and the resume pass lets it go when what it waits for comes (turn-resume.ts, releaseBooked).
                const booking = bookingFor(services(), said, Date.now());
                if (unbookable(booking)) {
                    return booking;
                }
                if (booking !== undefined) {
                    return book(item, booking);
                }
                const receipt = await admit(item);
                if ("delivered" in receipt) {
                    kept(conversationId, new Map([[item.id, receipt]]));
                }
                return receipt;
            }),
        steerIn: (conversationId, steer) =>
            inTurn(conversationId, async () => {
                const earlier = await duplicate(conversationId, steer.messageId);
                if (earlier !== undefined) {
                    return earlier;
                }
                const daemon = services();
                const steered = await steerPerson(daemon, conversationId, steer);
                if (steered !== true) {
                    return steered;
                }
                const receipt: MessageReceipt = { delivered: "steered", ...opt("run", liveRunOf(daemon.conversations, conversationId)?.id) };
                if (steer.messageId !== undefined) {
                    kept(conversationId, new Map([[steer.messageId, receipt]]));
                }
                return receipt;
            }),
        drain: (conversationId) =>
            inTurn(conversationId, async () => {
                handBack(conversationId);
                kept(conversationId, await deliver(conversationId));
            }),
        unqueue: ({ conversationId, id, revision }) =>
            inTurn(conversationId, async () => services().conversations.send(conversationId, { kind: "queue-removed", id, revision }).reply),
        reword: ({ conversationId, id, revision, text }) =>
            inTurn(conversationId, async () => services().conversations.send(conversationId, { kind: "queue-edited", id, revision, text }).reply),
        // The hold let go, with the bookings of the messages named (every one's when none are), and what can go goes.
        release: ({ conversationId, routing, ids }) =>
            inTurn(conversationId, async () => {
                services().conversations.send(conversationId, { kind: "queue-released", ...opt("routing", routing), ...opt("ids", ids) });
                const delivered = await deliver(conversationId);
                kept(conversationId, delivered);
                return opt("run", [...delivered.values()].find((receipt) => receipt.delivered === "started")?.run);
            }),
        // What waits, booked anew (only the messages named, when any are): held by whatever held it before or by nothing
        // (messages behind a running turn), it now waits for this. Nothing left to wait for lets it go now, as a release
        // would. A message named that no longer waits is missing, and nothing is re-timed in its place.
        reschedule: ({ conversationId, sendAt, sendAfter, ids }) =>
            inTurn(conversationId, async () => {
                const daemon = services();
                const { items } = daemon.conversations.queued(conversationId);
                if (items.length === 0 || (ids !== undefined && !ids.every((id) => items.some((item) => item.id === id)))) {
                    return "missing";
                }
                const booking = bookingOfAsk(daemon, { conversationId, sendAt, sendAfter }, Date.now());
                if (unbookable(booking)) {
                    return { invalid: "invalid" in booking ? booking.invalid : booking.why };
                }
                if (booking === undefined) {
                    daemon.conversations.send(conversationId, { kind: "queue-released", ...opt("ids", ids) });
                    kept(conversationId, await deliver(conversationId));
                    return "released";
                }
                return daemon.conversations.send(conversationId, { kind: "queue-rescheduled", booking, ...opt("ids", ids) }).reply ? "booked" : "missing";
            }),
    };
};
