import type { PushNotification } from "@intentic/sandbox-contract";

/* The wording of every notification this daemon sends, in one file. Kept out of the subsystems that TRIGGER
 * them (turn-runs knows a turn settled; the scheduler knows a wake is held) so that neither has to carry copy,
 * and so the whole vocabulary a user can receive is readable in one place.
 *
 * Two conventions run through all of them:
 *   - `tag` is per-conversation (or per-automation), so a replacement collapses onto its predecessor. Without
 *     it, a chatty turn that asks three permissions leaves three notifications the user must dismiss.
 *   - `requireInteraction` is set only when the agent is BLOCKED. A "finished" notice that auto-dismisses is
 *     fine; a request for input that auto-dismisses is a question that silently went unanswered. */

// A prompt trimmed to something that fits a lock screen without a mid-word cut.
const summarize = (prompt: string, limit = 90): string => {
    const flat = prompt.replace(/\s+/g, " ").trim();
    if (flat.length <= limit) {
        return flat;
    }
    const cut = flat.slice(0, limit);
    const lastSpace = cut.lastIndexOf(" ");
    return `${lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut}…`;
};

// Where a notification takes you: the conversation it is about. The web client routes chat by conversation,
// and the service worker prefers focusing an already-open tab over spawning a new one.
const conversationUrl = (conversationId: string): string => `/?conversation=${encodeURIComponent(conversationId)}`;

export const turnFinished = (conversationId: string, prompt: string, outcome: { ok: boolean; error?: string }): PushNotification => ({
    title: outcome.ok ? "Turn finished" : "Turn failed",
    body: outcome.ok ? summarize(prompt) : summarize(outcome.error ?? prompt),
    url: conversationUrl(conversationId),
    tag: `turn-${conversationId}`,
});

const AWAITING: Record<"plan" | "question" | "permission", { title: string; body: string }> = {
    plan: { title: "Plan ready for review", body: "The agent proposed a plan and is waiting for your approval." },
    question: { title: "The agent has a question", body: "It stopped to ask you something before continuing." },
    permission: { title: "Permission needed", body: "The agent is waiting for you to allow a tool it wants to run." },
};

export const turnAwaiting = (conversationId: string, kind: "plan" | "question" | "permission"): PushNotification => ({
    ...AWAITING[kind],
    url: conversationUrl(conversationId),
    // One tag across all three kinds: while a turn is parked there is exactly one thing to answer, so a
    // permission prompt following a question should REPLACE it rather than queue behind it.
    tag: `awaiting-${conversationId}`,
    requireInteraction: true,
});

// An automation has no title of its own — its prompt is the only human-readable thing about it, and it is
// what the Automations page shows too, so the notification names it the same way the UI does.
export const automationPending = (automationId: string, prompt: string): PushNotification => ({
    title: "Automation needs approval",
    body: summarize(prompt),
    url: `/automations`,
    tag: `approval-${automationId}`,
    requireInteraction: true,
});
