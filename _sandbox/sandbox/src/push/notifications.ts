import { commandRunOutcome, type ParkKind, type PushNotification, type PushRun } from "@intentic/sandbox-contract";

// Every notification's fixed wording, kept out of the subsystems that trigger it so the vocabulary a user can receive
// lives in one place.
// - `tag` collapses a replacement onto its predecessor: one per waiting card or need, so two waiting at once both stay on
//   screen; one per conversation for a finished turn, per automation or repository for the rest.
// - `requireInteraction` is set only while the agent is blocked waiting on an answer.

// Trims a prompt to fit a lock screen without cutting mid-word.
const summarize = (prompt: string, limit = 90): string => {
    const flat = prompt.replace(/\s+/g, " ").trim();
    if (flat.length <= limit) {
        return flat;
    }
    const cut = flat.slice(0, limit);
    const lastSpace = cut.lastIndexOf(" ");
    return `${lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut}…`;
};

// Must match the route the web client uses to open a conversation.
const conversationUrl = (conversationId: string): string => `/?conversation=${encodeURIComponent(conversationId)}`;

export const turnFinished = (conversationId: string, prompt: string, outcome: { ok: boolean; error?: string }): PushNotification => ({
    title: outcome.ok ? "Turn finished" : "Turn failed",
    body: outcome.ok ? summarize(prompt) : summarize(outcome.error ?? prompt),
    url: conversationUrl(conversationId),
    tag: `turn-${conversationId}`,
});

// Each kind's words: `title` alone, `named` after the conversation's own title ("Fix the login redirect: permission
// needed"), and `body` for when the card's own line could not be read.
const AWAITING: Record<ParkKind, { readonly title: string; readonly named: string; readonly body: string }> = {
    plan: { title: "Plan ready for review", named: "plan ready for review", body: "The agent proposed a plan and is waiting for your approval." },
    question: { title: "The agent has a question", named: "a question for you", body: "It stopped to ask you something before continuing." },
    permission: { title: "Permission needed", named: "permission needed", body: "The agent is waiting for you to allow a tool it wants to run." },
    browser_help: {
        title: "The agent's browser needs you",
        named: "its browser needs you",
        body: "It hit something only a person can clear, a captcha or a sign-in step.",
    },
    terminal_help: {
        title: "The agent's terminal needs you",
        named: "its terminal needs you",
        body: "A command it started is waiting at a prompt only you can answer.",
    },
    capability_offer: {
        title: "The agent needs something connected",
        named: "something to connect",
        body: "It asked you to connect something it needs and is waiting for your answer.",
    },
    payment_offer: {
        title: "A payment needs your approval",
        named: "a payment to approve",
        body: "The agent wants to pay for something and nothing moves until you answer.",
    },
    // Reaches every member who is away, not only the approvers the card names.
    credential_offer: {
        title: "A credential needs a named approver",
        named: "a credential to release",
        body: "The agent is waiting for one of the people named on it to release a credential.",
    },
};

// The waiting card a notification names, as awaiting-detail.ts reads it off the conversation's run.
export interface AwaitingCard {
    // Tags the notification, so a second waiting card stands beside the first instead of replacing it.
    readonly requestId: string;
    // What exactly it waits on, in one line: the question, the tool, the amount and where it goes.
    readonly detail?: string;
}

// Says who is waiting (the conversation's title) and on what (the card's line), each falling back to the kind's fixed
// words. A card that could not be read is tagged per conversation, so a later one replaces it.
export const turnAwaiting = (conversationId: string, kind: ParkKind, card?: AwaitingCard, conversationTitle?: string): PushNotification => {
    const words = AWAITING[kind];
    const who = summarize(conversationTitle ?? "", 40);
    const what = summarize(card?.detail ?? "");
    return {
        title: who === "" ? words.title : `${who}: ${words.named}`,
        body: what === "" ? words.body : what,
        url: conversationUrl(conversationId),
        tag: `awaiting-${card?.requestId ?? conversationId}`,
        requireInteraction: true,
    };
};

// A need an agent raised (docs/architecture/needs.md): named, since "the agent needs something" is not something a
// person can decide about from a lock screen. One tag per need, so two needs from one conversation both stay on screen.
export const needRaised = (need: { readonly id: string; readonly conversationId: string; readonly title: string; readonly why?: string | undefined }, conversationTitle: string | undefined): PushNotification => ({
    title: conversationTitle === undefined || conversationTitle === "" ? `An agent needs: ${need.title}` : `${summarize(conversationTitle, 40)} needs: ${need.title}`,
    body: need.why === undefined || need.why === "" ? "Answer it in the chat, or in Needs you." : summarize(need.why),
    url: `${conversationUrl(need.conversationId)}&need=${encodeURIComponent(need.id)}`,
    tag: `need-${need.id}`,
    requireInteraction: true,
});

// Sent when a push does not go through while the user is elsewhere.
// Title matches commandRunOutcome, the same wording the workspace card uses.
export const pushRefused = (run: PushRun): PushNotification => ({
    title: commandRunOutcome(run, "Push"),
    body: `${run.repo}: ${run.reason ?? run.command}`,
    url: "/workspace",
    // Per repository: a workspace can push several, a new verdict replaces the old one for that repo.
    tag: `push-${run.repo}`,
    requireInteraction: true,
});

// An automation has no title of its own; uses its prompt, the same label the Automations page shows.
export const automationPending = (automationId: string, prompt: string): PushNotification => ({
    title: "Automation needs approval",
    body: summarize(prompt),
    url: `/automations`,
    tag: `approval-${automationId}`,
    requireInteraction: true,
});

// Withdrawals: an ask that stopped waiting is replaced under its own tag (PushSender.withdraw), only on the devices its
// persistent notification reached. A replacement that shows something rather than a silent close, since browsers
// penalise a push that displays nothing; it carries no detail of the ask, which the lock screen already showed.
export const awaitingResolved = (conversationId: string, tag: string): PushNotification & { readonly tag: string } => ({
    title: "No longer waiting",
    body: "The agent is not waiting on you anymore.",
    url: conversationUrl(conversationId),
    tag,
});

export const needResolved = (need: { readonly id: string; readonly conversationId: string }): PushNotification & { readonly tag: string } => ({
    title: "No longer waiting",
    body: "This ask is settled.",
    url: conversationUrl(need.conversationId),
    tag: `need-${need.id}`,
});
