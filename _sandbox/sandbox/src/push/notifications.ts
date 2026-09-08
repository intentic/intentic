import { type CommandRun, commandRunOutcome, type PushNotification, type PushRun } from "@intentic/sandbox-contract";

// Every notification's fixed wording, kept out of the subsystems that trigger it so the vocabulary a user can receive
// lives in one place.
// - `tag` is per-conversation (or per-automation): a replacement collapses onto its predecessor.
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

export type AwaitingKind = "plan" | "question" | "permission" | "browser_help" | "terminal_help" | "credential_offer";

const AWAITING: Record<AwaitingKind, { title: string; body: string }> = {
    plan: { title: "Plan ready for review", body: "The agent proposed a plan and is waiting for your approval." },
    question: { title: "The agent has a question", body: "It stopped to ask you something before continuing." },
    permission: { title: "Permission needed", body: "The agent is waiting for you to allow a tool it wants to run." },
    browser_help: { title: "The agent's browser needs you", body: "It hit something only a person can clear, a captcha or a sign-in step." },
    terminal_help: { title: "The agent's terminal needs you", body: "A command it started is waiting at a prompt only you can answer." },
    // Broadcasts to every device, not just approvers: a push endpoint carries no member identity to target on.
    credential_offer: { title: "A credential needs a named approver", body: "The agent is waiting for one of the people named on it to release a credential." },
};

export const turnAwaiting = (conversationId: string, kind: AwaitingKind): PushNotification => ({
    ...AWAITING[kind],
    url: conversationUrl(conversationId),
    // One tag across all three kinds: a new prompt replaces the one on screen instead of queuing behind it.
    tag: `awaiting-${conversationId}`,
    requireInteraction: true,
});

// Sent when a pre-push check refuses or fails to run; a pass or a user-initiated cancel sends nothing.
// requireInteraction: the check is blocked on an answer, so the notice must not auto-dismiss.
export const prepushFailed = (run: CommandRun): PushNotification => ({
    title: commandRunOutcome(run, "Checks"),
    body: `${run.command}, your push is waiting on you.`,
    url: "/workspace",
    // One tag for the single check this daemon runs; a new verdict replaces rather than stacks.
    tag: "prepush",
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
