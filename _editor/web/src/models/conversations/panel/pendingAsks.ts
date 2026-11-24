import { isOpenNeed, type Need } from "@intentic/sandbox-contract/schemas/needs";
import { REQUEST_FIELDS, type RequestField } from "@intentic/sandbox-contract/events/transcript";
import { planParts } from "@intentic/sandbox-contract/text/title";
import type { IconName } from "@intentic/ui";
import { type AgentStanding, awaitingUser, onlyOwnerCanAnswer } from "../../agent-status/agentStatus-standing";
import { NEED_ICONS } from "../../needs/needStatus";
import type { ChatMessage } from "../transcript/transcript";
import { everyOf } from "../transcript/transcriptScan";

// EVERYTHING A CHAT WAITS ON A PERSON FOR, oldest first, as the dock above its composer lists it (ChatAskDock): the cards
// its turn is parked on, the needs it raised and went on without, the asks of the children it started that only a person
// can answer, and, before this window has drawn any card, what the agents list says it waits for. One list in the order
// asked, so the first thing the agent asked is the first thing the reader is shown, and the count is every one of them.
// The bar this replaced named only the newest card: four waited in a specimen while it named one, and the oldest was
// shown last. Each card used to be answered where it was asked, a scroll away; one question waited 3 h 36 min.

/** Which ask, in the words the composer and the board share. */
export type WaitKind = `plan` | `question` | `permission` | `other`;

// The cards whose whole body moves into the dock while they wait, leaving a one-line stub where they were asked. A plan
// and a page keep their body in the transcript, which is where they are read; the dock carries their answers or a way to them.
const DOCKED_FIELDS: ReadonlySet<RequestField> = new Set<RequestField>([
    `question`,
    `permission`,
    `browserHelp`,
    `terminalHelp`,
    `capabilityOffer`,
    `paymentOffer`,
    `credentialOffer`,
]);

// The glyph each card wears, as its own ChatCard does, so a chip and the card it opens read as one thing.
const CARD_ICONS = {
    plan: `list-check`,
    question: `comments`,
    permission: `shield`,
    browserHelp: `desktop`,
    terminalHelp: `terminal`,
    capabilityOffer: `bolt`,
    paymentOffer: `credit-card`,
    credentialOffer: `key`,
    pageAsk: `globe`,
} as const satisfies Record<RequestField, IconName>;
// What an undrawn ask wears, by what the agents list says it is.
const UNDRAWN_ICONS = { plan: `list-check`, question: `comments`, permission: `shield`, other: `exclamation-circle` } as const satisfies Record<WaitKind, IconName>;

interface AskLook {
    /** Stable across frames: what keeps the reader's pick on the same ask while others come and go. */
    readonly key: string;
    readonly icon: IconName;
    /** The ask in a few words, for its chip; empty where the data has none (the dock words a fallback). */
    readonly label: string;
}

export interface CardAsk extends AskLook {
    readonly source: `card`;
    readonly field: RequestField;
    readonly kind: WaitKind;
    readonly requestId: string;
    readonly message: ChatMessage;
}
export interface NeedAsk extends AskLook {
    readonly source: `need`;
    readonly need: Need;
}
export interface ChildAsk extends AskLook {
    readonly source: `child`;
    readonly kind: WaitKind;
    readonly agentId: string;
}
/** The agents list says the turn waits, and this window has not drawn the card yet. */
export interface UndrawnAsk extends AskLook {
    readonly source: `undrawn`;
    readonly kind: WaitKind;
}
export type PendingAsk = CardAsk | NeedAsk | ChildAsk | UndrawnAsk;

/** Whether the dock draws this ask's whole card, rather than a way to where it is answered. */
export const dockedBody = (ask: PendingAsk): boolean => (ask.source === `card` ? DOCKED_FIELDS.has(ask.field) : ask.source === `need`);

const kindOf = (field: RequestField): WaitKind => {
    if (field === `plan` || field === `permission`) {
        return field;
    }
    // A page asked to be answered on is a question in another form.
    return field === `question` || field === `pageAsk` ? `question` : `other`;
};

// Several questions on one card: their short headers side by side, else the first and how many more.
const questionLabel = (message: ChatMessage): string => {
    const asks = message.question?.questions ?? [];
    if (asks.length <= 1) {
        return asks[0]?.question ?? ``;
    }
    const headers = asks.map((ask) => ask.header.trim());
    return headers.every((header) => header !== ``) ? headers.join(` · `) : `${asks[0]?.question ?? ``} +${asks.length - 1}`;
};

const permissionLabel = (message: ChatMessage): string => {
    const card = message.permission;
    return card?.child?.task ?? card?.displayName ?? card?.title ?? card?.toolName ?? ``;
};

const paymentLabel = (message: ChatMessage): string => {
    const offer = message.paymentOffer?.offer;
    return offer === undefined ? `` : `$${offer.amountUsd} ${offer.assetName}`;
};

// The few words a chip says, from the card's own data: what a person would call it at a glance.
const CARD_LABELS = {
    plan: (message) => planParts(message.plan?.text ?? ``).title ?? ``,
    question: questionLabel,
    permission: permissionLabel,
    pageAsk: (message) => message.pageAsk?.page.title ?? ``,
    browserHelp: (message) => message.browserHelp?.account ?? ``,
    terminalHelp: (message) => message.terminalHelp?.message ?? ``,
    capabilityOffer: (message) => message.capabilityOffer?.offer.name ?? ``,
    paymentOffer: paymentLabel,
    credentialOffer: (message) => message.credentialOffer?.offer.subject ?? ``,
} as const satisfies Record<RequestField, (message: ChatMessage) => string>;

// A need in the word it is known by: the secret's name, the tool, the service; its title where the kind has no such word.
const needLabel = (need: Need): string => {
    const subject = need.subject;
    switch (subject.kind) {
        case `secret`:
        case `capability`:
            return subject.name;
        case `environment`:
            return subject.tool;
        default:
            return need.title;
    }
};

const cardAskIn = (message: ChatMessage): CardAsk | undefined => {
    const field = REQUEST_FIELDS.find((candidate) => message[candidate]?.status === `pending`);
    const card = field === undefined ? undefined : message[field];
    if (field === undefined || card === undefined) {
        return undefined;
    }
    const childStart = field === `permission` && message.permission?.child !== undefined;
    return {
        source: `card`,
        key: `card:${card.requestId}`,
        field,
        kind: kindOf(field),
        requestId: card.requestId,
        message,
        icon: childStart ? `subagents` : CARD_ICONS[field],
        label: CARD_LABELS[field](message).trim(),
    };
};

const needAskOf = (need: Need): NeedAsk => ({ source: `need`, key: `need:${need.id}`, need, icon: NEED_ICONS[need.subject.kind], label: needLabel(need) });

// A row's part in the list: the card it holds, or the need it raised. A need row stands for the need's LIVE state, read
// at the end, so here it says where in the order the need was asked, and what the row recorded of it.
type Found = { readonly card: CardAsk } | { readonly snapshot: Need };
const foundIn = (message: ChatMessage): Found | undefined => {
    if (message.role === `notice` && message.need !== undefined) {
        return { snapshot: message.need };
    }
    const card = cardAskIn(message);
    return card === undefined ? undefined : { card };
};

/** A child agent as the dock reads it off the fleet: one only a person can answer is the parent's reader's to see. */
export interface ChildStanding extends AgentStanding {
    readonly id: string;
    readonly title: string;
}

export interface AskSources {
    /** Whether a person has ended this turn: a turn ended owes nobody an answer, whatever it is still unwinding. */
    readonly ended: boolean;
    /** The needs this chat raised that are still open, live. */
    readonly needs: readonly Need[];
    /** A need's live state by id, whatever its standing: what a row's need is read as, its own record when the store has none. */
    readonly needById: (id: string) => Need | undefined;
    /** This chat's children on the board, each with what it waits on. */
    readonly children: readonly ChildStanding[];
    /** What the agents list says the chat waits on, for before the card is drawn. */
    readonly waitsOn: WaitKind | undefined;
}

/** What the agents list says a chat waits on a person for, in the board's own rank; undefined when it waits on nobody. */
export const waitKindOf = (agent: AgentStanding): WaitKind | undefined => {
    if (!awaitingUser(agent)) {
        return undefined;
    }
    if (agent.attention.plan) {
        return `plan`;
    }
    if (agent.attention.question) {
        return `question`;
    }
    return agent.attention.permission ? `permission` : `other`;
};

const childAskOf = (child: ChildStanding): ChildAsk | undefined => {
    const kind = waitKindOf(child);
    // A child's question is its parent's to answer (subagents/children.ts); only what the parent cannot answer reaches here.
    return kind === undefined || !onlyOwnerCanAnswer(child)
        ? undefined
        : { source: `child`, key: `child:${child.id}`, kind, agentId: child.id, icon: `subagents`, label: child.title };
};

/**
 * Every pending ask of one chat, oldest first. A reader, like transcriptScan's: it reads only the rows changed since its
 * last read, since the dock asks on every frame of a streamed turn. One per transcript.
 */
export const pendingAsksReader = (): ((messages: readonly ChatMessage[], sources: AskSources) => readonly PendingAsk[]) => {
    const scan = everyOf(foundIn);
    return (messages, sources) => {
        const open = new Map(sources.needs.filter(isOpenNeed).map((need) => [need.id, need]));
        const asks: PendingAsk[] = [];
        for (const found of scan(messages)) {
            if (`card` in found) {
                if (!sources.ended) {
                    asks.push(found.card);
                }
                continue;
            }
            // As the row's card reads it (NeedCard): live where the store holds it, else as the row recorded it.
            const need = sources.needById(found.snapshot.id) ?? found.snapshot;
            if (isOpenNeed(need) && !asks.some((ask) => ask.key === `need:${need.id}`)) {
                asks.push(needAskOf(need));
            }
            open.delete(need.id);
        }
        // Needs whose row this window does not hold (raised before the rows it read, or on its way), in the order raised.
        asks.push(...[...open.values()].sort((a, b) => a.createdAt - b.createdAt).map(needAskOf));
        asks.push(...sources.children.flatMap((child) => childAskOf(child) ?? []));
        if (!sources.ended && sources.waitsOn !== undefined && !asks.some((ask) => ask.source === `card`)) {
            asks.push({ source: `undrawn`, key: `undrawn`, kind: sources.waitsOn, icon: UNDRAWN_ICONS[sources.waitsOn], label: `` });
        }
        return asks;
    };
};
