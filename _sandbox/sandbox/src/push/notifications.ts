import { legacyPathOf, page, topPath } from "@intentic/sandbox-contract/app-routes";
import { commandRunOutcome } from "@intentic/sandbox-contract/policy/command-run";
import type { ParkKind } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { PushNotification } from "@intentic/sandbox-contract/schemas/push";
import type { PushRun } from "@intentic/sandbox-contract/schemas/git/git";
import type { DiskPressure } from "@intentic/sandbox-contract/schemas/metrics";

// Every notification's fixed wording, kept out of the subsystems that trigger it so the vocabulary a user can receive
// lives in one place.
// - `tag` collapses a replacement onto its predecessor: one per waiting card or need, so two waiting at once both stay on
//   screen; one per conversation for a finished turn, per automation or repository for the rest.
// - `requireInteraction` is set only while the agent is blocked waiting on an answer.
// - `url` is built by the editor's own table (@intentic/sandbox-contract/app-routes). A page of the sandbox is written in
//   the form addresses had before frames (`legacyPathOf`), which every editor opens in the sandbox its reader had open
//   last; the sender names this sandbox in it once it knows its own id (push.ts `placedIn`).

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

// Must match the route the web client uses to open a conversation: the bare address with `?conversation=`, which the
// editor's conversation-link guard reads (router/conversationLink.ts) and the Android app parses for its own screen.
export const conversationUrl = (conversationId: string, extra: { readonly need?: string } = {}): string =>
    topPath(`root`, {}, { conversation: conversationId, need: extra.need });

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
    page_ask: {
        title: "The agent is waiting on a page",
        named: "a page to answer",
        body: "It showed you a page to answer on and is waiting for what you choose.",
    },
    // Reaches the approvers the card names (awaiting-detail.ts), the only people whose press it takes.
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
    url: conversationUrl(need.conversationId, { need: need.id }),
    tag: `need-${need.id}`,
    requireInteraction: true,
});

// A person named another with @ in a message to a conversation (conversations/people/take-part.ts): they take part in it
// from now on, and this says who brought them in and with what words. One tag per conversation, so a second mention there
// replaces the first rather than stacking.
export const mentionedYou = (conversationId: string, by: string, conversationTitle: string | undefined, text: string): PushNotification => ({
    title: conversationTitle === undefined || conversationTitle === "" ? `${by} mentioned you` : `${by} mentioned you in ${summarize(conversationTitle, 40)}`,
    body: summarize(text),
    url: conversationUrl(conversationId),
    tag: `mention-${conversationId}`,
});

// Sent when a push does not go through while the user is elsewhere.
// Title matches commandRunOutcome, the same wording the workspace card uses.
export const pushRefused = (run: PushRun): PushNotification => ({
    title: commandRunOutcome(run, "Push"),
    body: `${run.repo}: ${run.reason ?? run.command}`,
    url: legacyPathOf(page.workspace()),
    // Per repository: a workspace can push several, a new verdict replaces the old one for that repo.
    tag: `push-${run.repo}`,
    requireInteraction: true,
});

const gigabytes = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

// The history volume under 10% or 5% free (system/resources/storage/disk-pressure.ts): how much is left, and what the
// sandbox already removed to make room. One tag, so the 5% word replaces the 10% one.
export const diskLow = (level: "low" | "critical", state: DiskPressure): PushNotification => {
    const percent = state.totalBytes > 0 ? Math.floor((state.freeBytes / state.totalBytes) * 100) : 0;
    const reaped =
        state.reaped === undefined || state.reaped.bytes === 0
            ? "No build output was left to remove."
            : `Removed ${gigabytes(state.reaped.bytes)} of build output from ${String(state.reaped.checkouts)} finished checkout(s).`;
    return {
        title: level === "critical" ? "The sandbox's disk is almost full" : "The sandbox's disk is getting full",
        body: `${gigabytes(state.freeBytes)} free (${String(percent)}%). ${reaped} Storage shows what is using the rest.`,
        url: legacyPathOf(page.sandboxSettings()),
        tag: "disk-low",
        requireInteraction: level === "critical",
    };
};

// Where every automation's news opens: the Automations view, which is the automations extension's own. Until 2026-11-04
// these pointed at `/automations`, a page the app does not have, so a tap opened nothing in particular.
const AUTOMATIONS_URL = legacyPathOf(page.extension(`automations`));

// An automation has no title of its own; uses its prompt, the same label the Automations page shows.
export const automationPending = (automationId: string, prompt: string): PushNotification => ({
    title: "Automation needs approval",
    body: summarize(prompt),
    url: AUTOMATIONS_URL,
    tag: `approval-${automationId}`,
    requireInteraction: true,
});

// A watch whose whole answer is this notification (target `notify`): what it watched for, and what its check saw. One tag
// per automation, so a watch that fires again replaces its last word rather than stacking.
export const automationFired = (
    automation: { readonly id: string; readonly note?: string | undefined; readonly prompt: string },
    saw: string | undefined,
): PushNotification => ({
    title: summarize(automation.note ?? `Automation ${automation.id} fired`, 60),
    body: saw === undefined || saw.trim() === "" ? summarize(automation.prompt) : summarize(saw),
    url: AUTOMATIONS_URL,
    tag: `automation-${automation.id}`,
});

// A watch that reached its deadline: said, because a watch that silently stops reads exactly like one still waiting.
export const automationExpired = (
    automation: { readonly id: string; readonly note?: string | undefined; readonly prompt: string },
    fired: boolean,
): PushNotification => ({
    title: fired ? "Watch ended" : "Watch gave up",
    body: `${summarize(automation.note ?? automation.prompt, 70)}: ${fired ? "it reached its end date and is switched off." : "it reached its end date without firing."}`,
    url: AUTOMATIONS_URL,
    tag: `automation-${automation.id}`,
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
