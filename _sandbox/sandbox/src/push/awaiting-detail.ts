import { type AskQuestion, type ParkKind, planParts, type TranscriptPlan, type TranscriptRow } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import type { LiveRun } from "../conversations/actor/conversation-holdings.js";
import { opt } from "../opt.js";
import { type AwaitingCard, turnAwaiting } from "./notifications.js";
import type { PushDelivery } from "./push.js";

// What a waiting card asks, read off the conversation's run as its notification goes out: every raiser announces only
// the card's kind (seams/domain-events.ts), and the row it raised says which question, which tool, how much and to
// whom. The run arrives from composition, since reading it from here would tie push to the conversations it serves.

// The request id and line of a card that still waits on its answer; answered, it is nobody's to be told about.
const waiting = <C extends { readonly requestId: string; readonly status: string }>(
    card: C | undefined,
    line: (card: C) => string | undefined,
): AwaitingCard | undefined => (card?.status === "pending" ? { requestId: card.requestId, ...opt("detail", line(card)) } : undefined);

// The first question, and how many more stand behind it on the same card.
const asked = (questions: readonly AskQuestion[]): string | undefined => {
    const [first] = questions;
    if (first === undefined) {
        return undefined;
    }
    const line = first.question.trim() === "" ? first.header : first.question;
    return questions.length > 1 ? `${line} (+${questions.length - 1} more)` : line;
};

// The plan's own heading, as its card titles it; else the document it points at; else its opening line.
const planned = (plan: TranscriptPlan): string | undefined =>
    planParts(plan.text).title ?? plan.document?.title ?? plan.text.split("\n").find((line) => line.trim() !== "");

// Where the money goes, by host: the card shows the whole address, where a lookalike can be read in full.
const hostOf = (url: string): string => URL.parse(url)?.host ?? url;

// Each kind's card on a row, and its line.
const LINES = {
    plan: (row) => waiting(row.plan, planned),
    question: (row) => waiting(row.question, (card) => asked(card.questions)),
    // The card's own header: the runtime's sentence, else the button's phrase, else the tool's name.
    permission: (row) => waiting(row.permission, (card) => card.title ?? card.displayName ?? card.toolName),
    browser_help: (row) => waiting(row.browserHelp, (card) => card.message),
    terminal_help: (row) => waiting(row.terminalHelp, (card) => card.message),
    capability_offer: (row) => waiting(row.capabilityOffer, (card) => `Connect ${card.offer.name}`),
    payment_offer: (row) => waiting(row.paymentOffer, (card) => `$${card.offer.amountUsd} to ${hostOf(card.offer.url)}`),
    credential_offer: (row) => waiting(row.credentialOffer, (card) => card.offer.subject),
} satisfies Record<ParkKind, (row: TranscriptRow) => AwaitingCard | undefined>;

// The newest card of this kind still waiting on its answer; undefined when the rows hold none, as when it was answered
// before its notification went out.
export const awaitingCard = (rows: readonly TranscriptRow[], kind: ParkKind): AwaitingCard | undefined => {
    const read = LINES[kind];
    const row = rows.findLast((candidate) => read(candidate) !== undefined);
    return row === undefined ? undefined : read(row);
};

// A card parking a conversation, as the announcement found it: `run` is that conversation's run, which holds the row.
export interface ParkedOn {
    readonly conversationId: string;
    readonly kind: ParkKind;
    readonly run: Pick<LiveRun, "rows"> | undefined;
    // Sent even while its person is active elsewhere in the editor (guard/card-offers.ts).
    readonly insist?: boolean;
}

// Tells the devices of whoever is away that a card waits, named after the conversation and in the card's own words; an
// insistent card tells them whether they are away or not.
export const notifyAwaiting = async (services: Pick<Services, "agents" | "pushSender">, parked: ParkedOn): Promise<PushDelivery> => {
    // A card the turn raised itself is announced just before its frame folds into the run (agent/run/turn/turn-runs.ts),
    // one raised outside the turn just after (card-offers.ts). One microtask on, either row is there, and the turn has
    // not yet folded a frame after it: a second card of the same kind would otherwise be read as this one.
    await Promise.resolve();
    const card = parked.run === undefined ? undefined : awaitingCard(parked.run.rows, parked.kind);
    const title = services.agents.entry(parked.conversationId)?.social.title?.text;
    const notification = turnAwaiting(parked.conversationId, parked.kind, card, title);
    return parked.insist === true ? services.pushSender.notify(notification) : services.pushSender.notifyIfAway(notification);
};
