import { type CommandRun, commandRunOutcome, type PushNotification, type PushRun } from "@intentic/sandbox-contract";

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

export type AwaitingKind = "plan" | "question" | "permission" | "browser_help" | "terminal_help" | "credential_offer";

const AWAITING: Record<AwaitingKind, { title: string; body: string }> = {
    plan: { title: "Plan ready for review", body: "The agent proposed a plan and is waiting for your approval." },
    question: { title: "The agent has a question", body: "It stopped to ask you something before continuing." },
    permission: { title: "Permission needed", body: "The agent is waiting for you to allow a tool it wants to run." },
    browser_help: { title: "The agent's browser needs you", body: "It hit something only a person can clear, a captcha or a sign-in step." },
    terminal_help: { title: "The agent's terminal needs you", body: "A command it started is waiting at a prompt only you can answer." },
    /* THE ONE CARD WHOSE AUDIENCE IS NOT WHOEVER STARTED THE WORK. The five above interrupt the person who
     * set a turn going and is likely still nearby; a gated credential waits for the people the OWNER named,
     * who may have no idea a turn is running at all. So it is the offer kind that earns a notification while
     * its siblings (a payment, a priced run, a capability setup) do not: those wait for the owner, who is
     * already looking at the chat they asked the question from.
     *
     * IT GOES TO EVERY REGISTERED DEVICE, not to the approvers alone, and that is a known gap rather than a
     * choice: a push channel is a browser endpoint or a relay device id and carries no member identity
     * (push-store.ts), so there is nothing here to address by email. The body therefore says a credential
     * rather than WHICH one, and names nobody: a notification is delivered to devices this daemon cannot
     * attribute to a person, so it must not leak who is being asked for what. */
    credential_offer: { title: "A credential needs a named approver", body: "The agent is waiting for one of the people named on it to release a credential." },
};

export const turnAwaiting = (conversationId: string, kind: AwaitingKind): PushNotification => ({
    ...AWAITING[kind],
    url: conversationUrl(conversationId),
    // One tag across all three kinds: while a turn is parked there is exactly one thing to answer, so a
    // permission prompt following a question should REPLACE it rather than queue behind it.
    tag: `awaiting-${conversationId}`,
    requireInteraction: true,
});

/* A pre-push check that said no while the user was somewhere else. Sent for a suite that RAN and refused, and
 * for one that could not run at all, both leave a push the user asked for standing unsent, which is the only
 * reason to interrupt them. A pass sends nothing (the push simply goes), and neither does a cancel: the hand on
 * the Stop button was theirs.
 *
 * `requireInteraction`, because this IS the blocked case, the push is held waiting on an answer, and a notice
 * that auto-dismisses is a decision nobody made. The url goes to the workspace, though the app raises the same
 * question wherever the user lands. */
export const prepushFailed = (run: CommandRun): PushNotification => ({
    title: commandRunOutcome(run, "Checks"),
    body: `${run.command}, your push is waiting on you.`,
    url: "/workspace",
    // One tag for the check, of which this daemon has exactly one: a second verdict replaces the first rather
    // than stacking a notification per push attempt.
    tag: "prepush",
    requireInteraction: true,
});

/* The push itself not going, while the user was somewhere else: the same interruption as a red check, for the
 * same reason, work they asked to leave the machine is still on it. Titled by the same words the card in the
 * app uses (commandRunOutcome), so the phone and the workspace agree about what happened. */
export const pushRefused = (run: PushRun): PushNotification => ({
    title: commandRunOutcome(run, "Push"),
    body: `${run.repo}: ${run.reason ?? run.command}`,
    url: "/workspace",
    // Per repository: a workspace pushes several, and a second verdict for the same one replaces the first.
    tag: `push-${run.repo}`,
    requireInteraction: true,
});

// An automation has no title of its own, its prompt is the only human-readable thing about it, and it is
// what the Automations page shows too, so the notification names it the same way the UI does.
export const automationPending = (automationId: string, prompt: string): PushNotification => ({
    title: "Automation needs approval",
    body: summarize(prompt),
    url: `/automations`,
    tag: `approval-${automationId}`,
    requireInteraction: true,
});
