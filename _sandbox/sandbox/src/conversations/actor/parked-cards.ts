import { randomUUID } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AskQuestion } from "@intentic/sandbox-contract/events/requests";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { Caller } from "../../auth/auth.js";
import type { ConversationActors } from "./conversation-actors.js";
import type { Holding } from "./conversation-holdings.js";

// One registry for every parked card (plan, question, permission, a handover): mint an id, stream a frame carrying it,
// block until POST /agent/reply resolves it. A waiter always settles, an abort settles it with `onAbort` so the tool
// handler never hangs. Single-tenant daemon, so an unguessable id alone is the scoping.

// `by` names who answered where no caller can: night hours, which answer for a person who is asleep.
type Waiter = (reply: AgentReply, fromUser: boolean, caller: Caller | undefined, by?: string) => void;

// Undefined means anyone with a session may answer; a gated credential is the exception, addressed to a named list.
// Lives on the card, not the route, so a refusal leaves it parked rather than letting a stranger cancel it.
export type MayAnswer = (caller: Caller | undefined) => string | undefined;

interface Parked {
    readonly settle: Waiter;
    // Settles it with its abort stand-in, as if its turn had died; `reason` is for the log line only.
    readonly abort: (reason?: string) => void;
    readonly mayAnswer: MayAnswer | undefined;
}

// Held by the conversation it was raised on, which a dismissal must be able to name, and aborted when a dispose takes
// it. One raised on none (the runtime's own plan and permission cards) waits in the conversationless bucket, which no
// dispose reaches: its waiter's own signal, the turn's, is what bounds it.
const PARKED: Holding<Parked> = { name: "parked cards", dropped: (parked) => parked.abort("its conversation let its cards go") };

export interface RequestOptions {
    readonly mayAnswer?: MayAnswer;
    // The conversation whose standing yes may answer a permission card held conversationless (a runtime's own card, the
    // command gate's), filled in by the turn's own handle on the registry (standingOn).
    readonly standingFor?: string;
    // A card that asks every time (an owner's hard rule, a restart other conversations feel): no standing yes answers it.
    readonly alwaysAsks?: boolean;
    // What night hours may answer this card with, where they may answer it at all (NightCard below): set only by an
    // agent's own clarifying question and a plan the agent chose to make.
    readonly night?: NightCard;
}

// "Allow everything in this conversation", answered on any permission card and kept per conversation
// (personas/conversation-grants.ts): while it stands, every permission card raised there that a person could have
// allowed once settles at once as `everything`, the card still drawn and frozen in the transcript so what ran is on
// record. It never answers a card addressed to a named person or one that always asks, and it never turns a refusal
// into a yes, since a refused call raises no card.
export interface StandingYes {
    readonly allowed: (conversationId: string) => Promise<boolean>;
    readonly allow: (conversationId: string, by: string | undefined) => Promise<void>;
    // A grant that could not be read or kept: logged, and the card waits for a person as it would without one.
    readonly failed: (cause: unknown) => void;
}

const everythingFor = (requestId: string): AgentReply => ({ kind: "permission", requestId, decision: "everything" });

// Whether a card ever reached a person, and what came of it, was in no log: a stuck turn could not say if its card had
// been drawn, answered elsewhere, or cancelled when the turn ended. One compact line per step of a card's life: raised,
// answered (by whom, with which decision), cancelled (why), and a reply refused for being from the wrong person. The
// card's words and a question's answers stay out: the transcript holds those.
export type CardLog = (fields: Record<string, unknown>, message: string) => void;

// The reply's verdict fields only, never its free text (a question's answers, a feedback note).
const VERDICT_FIELDS = ["decision", "approve", "approved", "cancelled", "helped", "accepted", "connected", "paid"] as const;
const verdictOf = (reply: AgentReply): Record<string, unknown> =>
    Object.fromEntries(
        VERDICT_FIELDS.flatMap((field) => {
            const value = (reply as unknown as Record<string, unknown>)[field];
            return typeof value === "boolean" || typeof value === "string" ? [[field, value]] : [];
        }),
    );

// Why a card's own signal fired: its deadline, or the caller (the turn, the tool call) stopping.
const abortReason = (signal: AbortSignal): string => {
    const reason: unknown = signal.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
        return "its deadline passed unanswered";
    }
    return reason === undefined ? "its caller stopped waiting" : `its caller stopped waiting: ${errorMessage(reason)}`;
};

// What every line about one card names.
interface CardAbout {
    readonly conversationId?: string;
    readonly requestId: string;
    readonly kind: AgentReply["kind"];
}

// How a card stopped waiting, for its line: the reply, whether it was the card's answer, and who gave it.
interface SettledLine {
    readonly reply: AgentReply;
    readonly answered: boolean;
    readonly fromUser: boolean;
    readonly by: string | undefined;
    readonly cancelled: string | undefined;
    readonly waitedMs: number;
}

// The line a card's settling writes: answered, by whom and with what, or cancelled and why.
const logSettled = (log: CardLog, about: CardAbout, { reply, answered, fromUser, by, cancelled, waitedMs }: SettledLine): void => {
    if (answered) {
        log({ ...about, ...verdictOf(reply), by: by ?? "unattributed", waitedMs }, `card: ${about.kind} answered`);
        return;
    }
    log({ ...about, reason: cancelled ?? (fromUser ? `a reply of kind ${reply.kind} answered it` : "settled unanswered"), waitedMs }, `card: ${about.kind} cancelled`);
};

// Reads the standing yes for a card it may answer (`standingId`, the conversation it may answer it for): true when it
// stands. Read as the card is raised, before anyone is told it waits; a grant that cannot be read answers nothing.
const readStanding = (standing: StandingYes | undefined, standingId: string | undefined): Promise<boolean> =>
    standingId === undefined || standing === undefined
        ? Promise.resolve(false)
        : standing.allowed(standingId).catch((cause: unknown) => {
              standing.failed(cause);
              return false;
          });

// Bundled together since only this module can tell a real answer from the abort stand-in; re-deriving that from a
// caller's own abort signal would race the settle it describes.
export interface Settled<K extends AgentReply["kind"]> {
    readonly reply: Extract<AgentReply, { kind: K }>;
    readonly resolved: Extract<AgentEvent, { kind: "resolved" }>;
    // Who answered, verified on the request; absent on an abort or a caller with no member identity.
    readonly caller?: Caller;
}

export interface ParkedCard<K extends AgentReply["kind"]> {
    readonly id: string;
    readonly wait: (signal: AbortSignal) => Promise<Settled<K>>;
}

export interface ParkedCards {
    // `onAbort` is the reply synthesized if the turn dies first, worded so each caller's own tool result reads honestly.
    // `conversationId` is what the card was raised on behalf of.
    readonly create: <K extends AgentReply["kind"]>(
        kind: K,
        onAbort: Extract<AgentReply, { kind: K }>,
        conversationId?: string,
        options?: RequestOptions,
    ) => ParkedCard<K>;
    // Re-registers a card under the id it was originally raised with (turn-resume.ts): a fresh id would strand the
    // replayed frame and any saved answer draft, both keyed by the old one.
    readonly restore: <K extends AgentReply["kind"]>(
        id: string,
        kind: K,
        onAbort: Extract<AgentReply, { kind: K }>,
        conversationId?: string,
        options?: RequestOptions,
    ) => ParkedCard<K>;
    // Three outcomes, not two: `missing` (no such card, the ordinary case for a remote turn, so the parent tries the
    // runner) and `refused` (a real card, wrong person, left parked) must stay distinct, or a stranger's click would read
    // as a stale one.
    readonly resolve: (reply: AgentReply, caller?: Caller) => "settled" | "missing" | { readonly refused: string };
    // Which conversation is parked on this card, for a settlement that acts on the turn rather than only answering it.
    // Read before resolving; the card is gone once it settles.
    readonly conversationOf: (requestId: string) => string | undefined;
    // Whether anybody needs telling that this card waits (push/awaiting-detail.ts), answered once every answer the sandbox
    // gives on its own (night hours, the conversation's standing yes) has had its say: true while it still waits on a
    // person, false once it settled or one of those answered it. Undefined for a card this registry did not raise, or
    // raised so long ago it no longer remembers it, which nobody announces that late.
    readonly waitsOnPerson: (requestId: string) => Promise<boolean | undefined>;
}

/** How many cards the conversation's turn waits on an answer to; one answered leaves this count as its reply lands. */
export const cardsParkedOn = (conversations: Pick<ConversationActors, "holdings">, conversationId: string): number =>
    conversations.holdings(PARKED).of(conversationId).length;

// The conversation a standing yes may answer this card for, or undefined where none may.
const standingConversation = (kind: AgentReply["kind"], conversationId: string | undefined, options: RequestOptions | undefined): string | undefined =>
    kind === "permission" && options?.mayAnswer === undefined && options?.alwaysAsks !== true ? (conversationId ?? options?.standingFor) : undefined;

// The turn's own handle on the registry: a card it raises without naming a conversation may still be answered by this
// conversation's standing yes, while it stays held where it always was.
export const standingOn = (cards: ParkedCards, conversationId: string | undefined): ParkedCards =>
    conversationId === undefined
        ? cards
        : {
              ...cards,
              create: (kind, onAbort, cardConversation, options) =>
                  cards.create(kind, onAbort, cardConversation, cardConversation === undefined ? { ...options, standingFor: conversationId } : options),
          };

/* WHICH CARDS NIGHT HOURS MAY ANSWER, AND HOW THE CARD REGISTRY ASKS THEM (below).

   Asked twice over a card's life: as it is raised, before anybody is told it waits, so a card answered at once is never
   announced to anybody's phone; and again every so often while it waits, since the night may begin, or the last person
   leave the editor, while it does. */

// A card night hours may settle while the owner sleeps: an agent's own clarifying question, by what it asks, or a plan
// the agent chose to make rather than one the owner launched the turn in plan mode for. Never a permission, a hand-over,
// a consent gate posed as a question (fleet-gate.ts), or a card addressed to a named person: those wait for a person.
export type NightCard = { readonly questions: readonly AskQuestion[] } | { readonly plan: true };

// Night hours' answers (agent/night/night-answers.ts): what a card gets now, or undefined while they are not in force.
export interface NightAnswers {
    readonly answer: (requestId: string, card: NightCard) => AgentReply | undefined;
    // How often a card still waiting is asked again.
    readonly recheckMs: number;
}

// Who the card log names as having answered a card night hours settled.
const NIGHT_HOURS = "night hours";

export interface NightOnCards {
    // The answer a card gets as it is raised, or undefined while night hours would not answer it.
    readonly onRaise: (requestId: string, card: NightCard | undefined) => AgentReply | undefined;
    // Asks again while the card waits and hands any answer to `settle`; answers the stop, called once the card settles.
    readonly watch: (requestId: string, card: NightCard | undefined, settle: (reply: AgentReply) => void) => () => void;
}

const NOTHING_TO_STOP = (): void => undefined;

/** The registry's side of night hours; with no answers given, nothing is ever answered and nothing is watched. */
const nightOnCards = (night: NightAnswers | undefined): NightOnCards => ({
    onRaise: (requestId, card) => (card === undefined ? undefined : night?.answer(requestId, card)),
    watch: (requestId, card, settle) => {
        if (card === undefined || night === undefined) {
            return NOTHING_TO_STOP;
        }
        const timer = setInterval(() => {
            const reply = night.answer(requestId, card);
            if (reply !== undefined) {
                settle(reply);
            }
        }, night.recheckMs);
        timer.unref();
        return () => clearInterval(timer);
    },
});

/* WHETHER ANYBODY NEEDS TELLING A CARD WAITS (below).

   A card is drawn the moment it is raised, so the transcript records it whatever becomes of it; what answers it on its
   own (night hours, the conversation's standing yes) is asked as it is raised, and the standing yes is a read of its
   file. The push that announces the card asks `waitsOnPerson` first, which waits for those answers rather than racing
   them. 2026-11-14: the standing yes was read only once the raiser waited on the card, after the push had gone out, so
   a conversation allowed everything still buzzed its owner's phone for a card that froze as Allowed before they could
   look at it. */

// What became of a recently raised card, as far as telling a person about it goes.
interface Fate {
    // Settles once every answer the sandbox gives on its own has had its say: true when one of them answered the card.
    readonly answeredAlone: Promise<boolean>;
    settled: boolean;
}

// How many recently raised cards are remembered: enough to outlast the push that announces a card a moment after its
// frame, never a list that grows with the sandbox's life.
const FATES_KEPT = 256;

// The fates of the newest cards, newest last, so the oldest is the first to go.
const recentFates = () => {
    const fates = new Map<string, Fate>();
    return {
        keep: (requestId: string, fate: Fate): void => {
            fates.set(requestId, fate);
            if (fates.size > FATES_KEPT) {
                fates.delete(fates.keys().next().value ?? requestId);
            }
        },
        waitsOnPerson: async (requestId: string): Promise<boolean | undefined> => {
            const fate = fates.get(requestId);
            if (fate === undefined) {
                return undefined;
            }
            const alone = await fate.answeredAlone;
            return !alone && !fate.settled;
        },
    };
};

// What answers a card without a person, started as it is raised: night hours, at once or later, and the conversation's
// standing yes once its file is read. `listen` hands those answers to the card's waiter, and answers the stop.
interface SelfAnswers {
    readonly atOnce: AgentReply | undefined;
    readonly fate: Fate;
    readonly listen: (settle: (reply: AgentReply, by: string | undefined) => void) => () => void;
}

const selfAnswers = (
    nights: NightOnCards,
    standing: StandingYes | undefined,
    // Every parked card a standing yes may answer, which this card joins once it waits.
    answerable: Map<string, string>,
    card: { readonly id: string; readonly restored: boolean; readonly night: NightCard | undefined; readonly standingId: string | undefined },
): SelfAnswers => {
    // Asked before the frame goes out; a restored card was announced before the restart, so it is only watched.
    const atOnce = card.restored ? undefined : nights.onRaise(card.id, card.night);
    const standsYes = atOnce === undefined ? readStanding(standing, card.standingId) : Promise.resolve(false);
    return {
        atOnce,
        fate: { answeredAlone: atOnce === undefined ? standsYes : Promise.resolve(true), settled: false },
        listen: (settle) => {
            if (card.standingId !== undefined && standing !== undefined) {
                answerable.set(card.id, card.standingId);
            }
            void standsYes.then((yes) => {
                if (yes) {
                    settle(everythingFor(card.id), undefined);
                }
            });
            return nights.watch(card.id, card.night, (reply) => settle(reply, NIGHT_HOURS));
        },
    };
};

/** A person's reply never carries night hours' mark, whatever the request said: only the registry's own answer does. */
const asPersons = (reply: AgentReply): AgentReply => {
    if ((reply.kind !== "question" && reply.kind !== "plan") || reply.night === undefined) {
        return reply;
    }
    const copy = { ...reply };
    delete copy.night;
    return copy;
};

// The cards parked in these actors' conversations, and in their conversationless bucket. `settled` hears every card
// that stops waiting, answered (by a person or a standing yes) or aborted, as it stops: the one moment that is true
// wherever the answer came from (this browser, another device, a stop), which is what withdrawing the card's push
// notification needs. A conversationless card names the conversation its turn raised it for, where one did.
export const parkedCards = (
    conversations: Pick<ConversationActors, "holdings">,
    standing?: StandingYes,
    settled?: (requestId: string, conversationId: string | undefined) => void,
    log: CardLog = () => undefined,
    night?: NightAnswers,
): ParkedCards => {
    // Every parked card a standing yes may answer, by id, with the conversation it may answer it for.
    const answerable = new Map<string, string>();
    const nights = nightOnCards(night);
    const fates = recentFates();
    const park = <K extends AgentReply["kind"]>(
        restored: boolean,
        id: string,
        kind: K,
        onAbort: Extract<AgentReply, { kind: K }>,
        conversationId?: string,
        options?: RequestOptions,
    ): ParkedCard<K> => {
        const owner = conversationId ?? options?.standingFor;
        const about: CardAbout = { ...(owner === undefined ? {} : { conversationId: owner }), requestId: id, kind };
        // Asked now rather than once the raiser waits on the card, so the push announcing it waits for their answers.
        const self = selfAnswers(nights, standing, answerable, { id, restored, night: options?.night, standingId: standingConversation(kind, conversationId, options) });
        fates.keep(id, self.fate);
        const wait = (signal: AbortSignal): Promise<Settled<K>> =>
            new Promise((resolve) => {
                const parked = conversations.holdings(PARKED);
                let done = false;
                const raisedAt = Date.now();
                // Set by an abort just before it settles, so the line says why nobody answered.
                let cancelled: string | undefined;
                // What answers the card on its own while it waits, stopped once it settles.
                let stopSelf = (): void => undefined;
                const settle = (reply: AgentReply, fromUser: boolean, caller: Caller | undefined, by?: string): void => {
                    if (done) {
                        return;
                    }
                    done = true;
                    self.fate.settled = true;
                    stopSelf();
                    parked.drop(id);
                    answerable.delete(id);
                    settled?.(id, conversationId ?? options?.standingFor);
                    // A reply for the wrong card can only be a client bug: the waiter's kind is what its caller is
                    // typed against.
                    const answered = fromUser && reply.kind === kind;
                    logSettled(log, about, { reply, answered, fromUser, by: by ?? caller?.email, cancelled, waitedMs: Date.now() - raisedAt });
                    const settledReply = answered ? (reply as Extract<AgentReply, { kind: K }>) : onAbort;
                    // The abort stand-in wasn't chosen by anyone, so it carries no reply on the resolution frame.
                    resolve({
                        reply: settledReply,
                        resolved: { kind: "resolved", requestId: id, ...(answered ? { reply: settledReply } : {}) },
                        // Only a real answer carries a person; attributing the aborting request's identity would lie
                        // in an audit line.
                        ...(answered && caller !== undefined ? { caller } : {}),
                    });
                };
                const abort = (reason?: string): void => {
                    cancelled ??= reason;
                    settle(onAbort, false, undefined);
                };
                parked.hold(conversationId, id, { settle, abort, mayAnswer: options?.mayAnswer });
                log({ ...about, ...(restored ? { restored: true } : {}), ...(options?.alwaysAsks === true ? { alwaysAsks: true } : {}) }, `card: ${kind} raised`);
                const onAbortSignal = (): void => abort(abortReason(signal));
                if (signal.aborted) {
                    onAbortSignal();
                    return;
                }
                signal.addEventListener("abort", onAbortSignal, { once: true });
                if (self.atOnce !== undefined) {
                    settle(self.atOnce, true, undefined, NIGHT_HOURS);
                    return;
                }
                stopSelf = self.listen((reply, by) => settle(reply, true, undefined, by));
            });
        return { id, wait };
    };
    return {
        create: (kind, onAbort, conversationId, options) => park(false, randomUUID(), kind, onAbort, conversationId, options),
        restore: (id, kind, onAbort, conversationId, options) => park(true, id, kind, onAbort, conversationId, options),
        resolve: (reply, caller) => {
            const parked = conversations.holdings(PARKED).get(reply.requestId);
            if (parked === undefined) {
                return "missing";
            }
            // Consulted before settling, so a refusal costs the card nothing.
            const refused = parked.mayAnswer?.(caller);
            if (refused !== undefined) {
                log({ requestId: reply.requestId, kind: reply.kind, ...(caller?.email === undefined ? {} : { by: caller.email }), reason: refused }, "card: reply refused, the card stays parked");
                return { refused };
            }
            if (reply.kind !== "permission" || reply.decision !== "everything") {
                parked.settle(asPersons(reply), true, caller);
                return "settled";
            }
            const standingId = answerable.get(reply.requestId);
            // On a card no standing yes may answer, "everything" is the allow-once it can be.
            if (standingId === undefined || standing === undefined) {
                parked.settle({ ...reply, decision: "once" }, true, caller);
                return "settled";
            }
            parked.settle(reply, true, caller);
            void standing.allow(standingId, caller?.email).catch(standing.failed);
            // The cards already waiting in the same conversation are answered by the same yes.
            for (const [otherId, otherConversation] of answerable) {
                if (otherConversation === standingId) {
                    conversations.holdings(PARKED).get(otherId)?.settle(everythingFor(otherId), true, caller);
                }
            }
            return "settled";
        },
        conversationOf: (requestId) => conversations.holdings(PARKED).holder(requestId),
        waitsOnPerson: fates.waitsOnPerson,
    };
};
