import { askedAudience } from "./push-audience.js";
import type { AskQuestion } from "@intentic/sandbox-contract/events/requests";
import type { ParkKind } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { planParts } from "@intentic/sandbox-contract/text/title";
import type { TranscriptPlan, TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { Services } from "../composition.js";
import type { LiveRun } from "../conversations/actor/conversation-holdings.js";
import { opt } from "../opt.js";
import { type AwaitingCard, turnAwaiting } from "./notifications.js";
import type { PushDelivery } from "./push.js";

// What a waiting card asks, read off the conversation's run as its notification goes out: every raiser announces the
// card's kind and request id (seams/domain-events.ts), and the row it raised says which question, which tool, how much
// and to whom. The run arrives from composition, since reading it from here would tie push to the conversations it
// serves.

// A card as a row holds it, whatever became of it: its request id, whether it still waits on its answer, and its line.
interface RowCard {
    readonly requestId: string;
    readonly pending: boolean;
    readonly detail?: string;
}

const onRow = <C extends { readonly requestId: string; readonly status: string }>(card: C | undefined, line: (card: C) => string | undefined): RowCard | undefined =>
    card === undefined ? undefined : { requestId: card.requestId, pending: card.status === "pending", ...opt("detail", line(card)) };

const asAwaiting = ({ requestId, detail }: RowCard): AwaitingCard => ({ requestId, ...opt("detail", detail) });

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
    plan: (row) => onRow(row.plan, planned),
    question: (row) => onRow(row.question, (card) => asked(card.questions)),
    // The card's own header: the runtime's sentence, else the button's phrase, else the tool's name.
    permission: (row) => onRow(row.permission, (card) => card.title ?? card.displayName ?? card.toolName),
    browser_help: (row) => onRow(row.browserHelp, (card) => card.message),
    terminal_help: (row) => onRow(row.terminalHelp, (card) => card.message),
    capability_offer: (row) => onRow(row.capabilityOffer, (card) => `Connect ${card.offer.name}`),
    payment_offer: (row) => onRow(row.paymentOffer, (card) => `$${card.offer.amountUsd} to ${hostOf(card.offer.url)}`),
    credential_offer: (row) => onRow(row.credentialOffer, (card) => card.offer.subject),
    page_ask: (row) => onRow(row.pageAsk, (card) => card.page.title),
} satisfies Record<ParkKind, (row: TranscriptRow) => RowCard | undefined>;

// Who may release a credential card: the people named on it, the only ones whose press it takes.
const approversOf = (rows: readonly TranscriptRow[], requestId: string): readonly string[] | undefined =>
    rows.findLast((row) => row.credentialOffer?.requestId === requestId)?.credentialOffer?.offer.approvers;

// The newest card of this kind still waiting on its answer; undefined when the rows hold none.
export const awaitingCard = (rows: readonly TranscriptRow[], kind: ParkKind): AwaitingCard | undefined => {
    const read = LINES[kind];
    const row = rows.findLast((candidate) => read(candidate)?.pending === true);
    const card = row === undefined ? undefined : read(row);
    return card === undefined ? undefined : asAwaiting(card);
};

// The card of this kind the rows hold under this request id, waiting or not.
const raisedCard = (rows: readonly TranscriptRow[], kind: ParkKind, requestId: string): RowCard | undefined => {
    const read = LINES[kind];
    const row = rows.findLast((candidate) => read(candidate)?.requestId === requestId);
    return row === undefined ? undefined : read(row);
};

// A card parking a conversation, as the announcement found it: `run` is that conversation's run, which holds the row.
export interface ParkedOn {
    readonly conversationId: string;
    readonly kind: ParkKind;
    // The card it parked on, which every announcement in the daemon names; without one, the newest card of the kind
    // still waiting is read as it.
    readonly requestId?: string;
    readonly run: Pick<LiveRun, "rows"> | undefined;
    // Sent even while its person is active elsewhere in the editor (guard/card-offers.ts).
    readonly insist?: boolean;
}

// What a card's push sends when it sends nothing: the card stopped waiting before anybody was told, answered by what
// answers cards on their own (night hours, the conversation's standing yes) or by a person quicker than the push.
const ANSWERED: PushDelivery = { delivered: 0, failed: 0, skipped: "answered before anyone was told" };

/* The card to tell its people of, or `answered` when nobody needs telling; undefined when it cannot be read, which is
 * told in the kind's own words. Nobody is told of a card before the registry says it still waits on a person: what
 * answers a card on its own was asked as it was raised, and the standing yes is a read of a file, so the push waits for
 * it rather than racing it (conversations/actor/parked-cards.ts `waitsOnPerson`). A card the turn raised itself is
 * announced just before its frame folds into the run (agent/run/turn/turn-runs.ts), one raised outside the turn just
 * after (card-offers.ts), so its row is read a microtask on at the soonest. */
const cardToTell = async (services: Partial<Pick<Services, "cards">>, parked: ParkedOn): Promise<AwaitingCard | "answered" | undefined> => {
    await Promise.resolve();
    const waits = parked.requestId === undefined ? undefined : await services.cards?.waitsOnPerson(parked.requestId);
    if (waits === false) {
        return "answered";
    }
    if (parked.run === undefined) {
        return undefined;
    }
    if (parked.requestId === undefined) {
        return awaitingCard(parked.run.rows, parked.kind);
    }
    const raised = raisedCard(parked.run.rows, parked.kind, parked.requestId);
    if (raised === undefined) {
        return undefined;
    }
    return raised.pending ? asAwaiting(raised) : "answered";
};

// Pushes the card to the devices of the people it waits on: while they are away, or whether or not they are when it
// insists.
const pushCard = (services: Pick<Services, "agents" | "pushSender">, parked: ParkedOn, card: AwaitingCard | undefined): Promise<PushDelivery> => {
    const title = services.agents.entry(parked.conversationId)?.social.title?.text;
    const notification = turnAwaiting(parked.conversationId, parked.kind, card, title);
    // The people the conversation's cards wait on (push-audience.ts); a credential's, the people named on it.
    const approvers = parked.kind === "credential_offer" && card !== undefined && parked.run !== undefined ? approversOf(parked.run.rows, card.requestId) : undefined;
    const to = askedAudience((id) => services.agents.entry(id), parked.conversationId, approvers);
    return parked.insist === true ? services.pushSender.notify(notification, to) : services.pushSender.notifyIfAway(notification, to);
};

// Tells the devices of the people a card waits on, while they are away, that it waits, named after the conversation and
// in the card's own words; an insistent card tells them whether they are away or not. A card that stopped waiting
// before then tells nobody.
export const notifyAwaiting = async (
    services: Pick<Services, "agents" | "pushSender"> & Partial<Pick<Services, "logger" | "cards">>,
    parked: ParkedOn,
): Promise<PushDelivery> => {
    const card = await cardToTell(services, parked);
    const delivery = card === "answered" ? ANSWERED : await pushCard(services, parked, card);
    // Whether the owner's devices were told is half of "did the card reach anyone"; the other half is the card's own
    // line (parked-cards.ts).
    services.logger?.info(
        {
            conversationId: parked.conversationId,
            kind: parked.kind,
            ...opt("requestId", parked.requestId),
            delivered: delivery.delivered,
            failed: delivery.failed,
            ...opt("skipped", delivery.skipped),
            ...(parked.insist === true ? { insist: true } : {}),
        },
        delivery.skipped === undefined
            ? `card push: ${parked.kind} sent to ${delivery.delivered} of ${delivery.delivered + delivery.failed} devices`
            : `card push: ${parked.kind} not sent, ${delivery.skipped}`,
    );
    return delivery;
};
