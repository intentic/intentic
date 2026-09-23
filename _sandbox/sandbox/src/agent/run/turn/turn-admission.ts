import { randomUUID } from "node:crypto";
import { MENTION_LIMIT, type MessageReceipt } from "@intentic/sandbox-contract";
import { type LiveRun, liveRunOf, turnRunOf } from "../../../agents/actor/conversation-holdings.js";
import type { QueuedItem } from "../../../agents/actor/conversation-queue.js";
import { cardsParkedOn } from "../../../agents/actor/parked-cards.js";
import { worktreeOf } from "../../../agents/registry/agents-store.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { Said, Steer, TurnInput, TurnStarter, Unsteered } from "../../../seams/turn-starter.js";
import { recordConversationPrompt, recordPrompt } from "../../../sessions/transcript-search.js";
import { steerTurn } from "../../checkpoints/agent-steering.js";
import { checkpointSteeredMessage } from "../../checkpoints/steer-checkpoints.js";
import { keepReceipt, receiptOf } from "./message-receipts.js";
import { composeSteerText } from "./turn-interactions.js";

// Every message to a conversation comes through here, whoever sends it: said into the live turn where that turn takes
// words, started as a turn of its own when nothing runs, and otherwise queued on the conversation's actor until one of
// those can happen. Answered with what became of it, which the same message id sent again gets back instead of a second
// delivery. One piece of work at a time per conversation, so a message, its resend and a drain never decide at once.

type Turn = TurnInput & { readonly conversationId: string };

// A person's words for the live turn, and the id that names them.
type PersonSteer = Omit<Steer, "voice" | "outside">;

const NOT_STEERABLE: Unsteered = { why: "no steerable turn running for that conversation" };

// Hands the words to the live turn wherever it runs: composed against this workspace for a local one, uncomposed to a
// runner's, whose paths resolve only in its own workspace.
const handOver = async (services: Services, conversationId: string, steer: PersonSteer): Promise<true | Unsteered> => {
    const runnerId = worktreeOf(services.agents.entry(conversationId))?.runner;
    if (runnerId === undefined) {
        const composed = await composeSteerText(services.workspace.root, steer);
        if (composed.invalid !== undefined) {
            return { invalid: composed.invalid };
        }
        return steerTurn(services.conversations, conversationId, { text: composed.text, voice: "person" }) || NOT_STEERABLE;
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
    const { actor, owner, areas, unseenRuns: _unseen, ...turn } = said.turn;
    const id = turn.messageId ?? randomUUID();
    return {
        id,
        voice: said.voice,
        ...opt("actor", actor),
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
    ...opt("actor", item.actor),
    ...opt("owner", item.owner),
    ...opt("areas", item.areas),
    ...opt("outsideWake", item.outside),
});

// What goes before anything waiting: a recovery the daemon runs by itself, or a rewind restoring files.
const goesFirst = (services: Services, conversationId: string): boolean => {
    const state = services.conversations.state(conversationId);
    return state?.turn.resuming === true || state?.phase.kind === "rewinding";
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
    const composed = await composeSteerText(services.workspace.root, words);
    if (composed.invalid !== undefined) {
        return { invalid: composed.invalid };
    }
    return steerTurn(services.conversations, conversationId, { text: composed.text, voice: item.voice, ...opt("outside", item.outside) }) || NOT_STEERABLE;
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

// Whether a drained batch goes on in the conversation's session: only on the runtime and account the session was minted
// on, the rule a composer sending directly applies for itself (turnRequest.ts `resumes`).
const continuesSession = (services: Services, routing: Pick<Turn, "conversationId" | "agent" | "harness" | "account">): boolean => {
    const profile = services.agents.entry(routing.conversationId)?.profile;
    if (profile === undefined || profile.provider !== (routing.agent ?? "claude") || profile.harness !== (routing.harness ?? "native")) {
        return false;
    }
    return routing.account === undefined || routing.account === profile.account;
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
        const { sessionId: _asked, ...wake } = requestOf(last);
        return { ...wake, ...opt("sessionId", services.conversations.sessionIdOf(conversationId)) };
    }
    const { prompt: _p, attachments: _a, mentions: _m, editorContext: _e, messageId: _i, sessionId: _s, ...routing } = requestOf(last);
    const attachments = batch.flatMap((item) => item.turn.attachments ?? []);
    const mentions = [...new Set(batch.flatMap((item) => item.turn.mentions ?? []))].filter((path) => !attachments.includes(path));
    const editorContext = batch.find((item) => item.turn.editorContext !== undefined)?.turn.editorContext;
    const session = continuesSession(services, routing) ? services.conversations.sessionIdOf(conversationId) : undefined;
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

// One piece of work per conversation at a time, each after the last however that one ended.
const oneAtATime = (): (<T>(conversationId: string, work: () => Promise<T>) => Promise<T>) => {
    const tails = new Map<string, Promise<unknown>>();
    return (conversationId, work) => {
        const next = (tails.get(conversationId) ?? Promise.resolve()).then(work, work);
        const tail = next.catch(() => undefined);
        tails.set(conversationId, tail);
        void tail.then(() => {
            if (tails.get(conversationId) === tail) {
                tails.delete(conversationId);
            }
        });
        return next;
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
): Pick<TurnStarter, "say" | "steerIn" | "drain" | "unqueue" | "reword" | "release"> => {
    const inTurn = oneAtATime();
    const carrying = new Map<string, readonly Carrying[]>();

    const kept = (conversationId: string, receipts: ReadonlyMap<string, MessageReceipt>): void => {
        for (const [messageId, receipt] of receipts) {
            keepReceipt(services().conversations, conversationId, messageId, receipt);
        }
    };

    // Starts the turn a batch makes; a person's is watched until it settles, since a refusal at the door hands its words
    // back to the queue rather than the sandbox holding the turn.
    const startWith = async (batch: readonly Omit<QueuedItem, "revision">[], turn: Turn): Promise<string | undefined> => {
        const person = batch[0]?.voice === "person";
        const started = await start(turn, { senderKeeps: person });
        const run = started === undefined ? undefined : turnRunOf(services().conversations, turn.conversationId);
        if (person && run?.id === started?.id && run !== undefined) {
            carrying.set(turn.conversationId, [...(carrying.get(turn.conversationId) ?? []), { run, batch }]);
        }
        return started?.id;
    };

    // Whether anything waiting may go out now: a hold keeps it, and so does a recovery the daemon runs by itself or a rewind
    // restoring files, either of which goes first.
    const held = (conversationId: string): boolean => {
        const daemon = services();
        const queue = daemon.conversations.queued(conversationId);
        return queue.items.length === 0 || queue.paused !== undefined || goesFirst(daemon, conversationId);
    };

    // The next of the queue out: its head said into the live turn where that turn takes words, else one turn of what rides
    // together. Answers what it delivered, by message id; undefined when nothing could go.
    const step = async (conversationId: string): Promise<ReadonlyMap<string, MessageReceipt> | undefined> => {
        const daemon = services();
        const { items } = daemon.conversations.queued(conversationId);
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
        const batch = together(items);
        const run = await startWith(batch, turnOf(daemon, batch));
        if (run === undefined) {
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
    const intoLive = async (item: Omit<QueuedItem, "revision">, live: LiveRun | undefined): Promise<MessageReceipt | { readonly invalid: string } | undefined> => {
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
    // nothing runs; undefined when it has to wait, `invalid` when its references escape the workspace.
    const deliverNow = async (item: Omit<QueuedItem, "revision">): Promise<MessageReceipt | { readonly invalid: string } | undefined> => {
        const daemon = services();
        const { conversationId } = item.turn;
        if (goesFirst(daemon, conversationId)) {
            return undefined;
        }
        const live = liveRunOf(daemon.conversations, conversationId);
        if (live !== undefined || daemon.conversations.state(conversationId)?.phase.kind === "running") {
            return intoLive(item, live);
        }
        // Its own turn, as its sender asked for it, session and all.
        const run = await startWith([item], requestOf(item));
        return run === undefined ? undefined : { delivered: "started", run };
    };

    // A message nothing waits ahead of goes straight where it can; any other joins the queue, which then lets out what it
    // can, this message among it or not.
    const admit = async (item: Omit<QueuedItem, "revision">): Promise<MessageReceipt | { readonly invalid: string }> => {
        const { conversationId } = item.turn;
        const queue = services().conversations.queued(conversationId);
        const now = queue.items.length === 0 && queue.paused === undefined ? await deliverNow(item) : undefined;
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

    return {
        say: (said) =>
            inTurn(said.turn.conversationId, async () => {
                const { conversationId, messageId } = said.turn;
                const earlier = await duplicate(conversationId, messageId);
                if (earlier !== undefined) {
                    return earlier;
                }
                const item = named(said);
                const receipt = await admit(item);
                if (!("invalid" in receipt)) {
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
        release: ({ conversationId, routing }) =>
            inTurn(conversationId, async () => {
                services().conversations.send(conversationId, { kind: "queue-released", ...opt("routing", routing) });
                const delivered = await deliver(conversationId);
                kept(conversationId, delivered);
                return opt("run", [...delivered.values()].find((receipt) => receipt.delivered === "started")?.run);
            }),
    };
};
