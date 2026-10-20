import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import type { AutomationRecord } from "../automations-store.js";

// The conversations a fire mints, and the sessions gate that counts every other one since this automation's last wake.

// Branch/worktree name bounded by ConversationIdSchema, built from the automation id with prefix/suffix room.
const AUTOMATION_ID_IN_CONVERSATION = 40;
// Prefix every fire's conversation carries; the mark a schedule wake leaves, read by the sessions gate.
const AUTOMATION_CONVERSATION_PREFIX = "a-";
// Fires of one automation can't share a millisecond; this makes the id unique per process regardless of caller.
let fireSeq = 0;
export const mintConversationId = (automationId: string, now: number): string =>
    `${AUTOMATION_CONVERSATION_PREFIX}${automationId.slice(0, AUTOMATION_ID_IN_CONVERSATION)}-${now.toString(36)}${(fireSeq++).toString(36)}`;

// Whether this automation minted that conversation id; a leftover "-" after the base36 suffix means only a prefix
// match. Used to exclude a job's own wakes from its sessions gate and its own `turn.settled`.
export const firedBy = (automationId: string, conversationId: string): boolean => {
    const mine = `${AUTOMATION_CONVERSATION_PREFIX}${automationId.slice(0, AUTOMATION_ID_IN_CONVERSATION)}-`;
    return conversationId.startsWith(mine) && !conversationId.slice(mine.length).includes("-");
};

// Sessions gate for afterSessions: fires once enough new sessions ran since the last wake, read from the newest
// conversation this automation minted, not the bounded run ledger.
interface SessionsSinceWake {
    // Epoch ms of the last wake's conversation; 0 when this automation has never woken an agent.
    readonly since: number;
    // Newest first.
    readonly sessions: readonly PersistedAgent[];
}

const sessionsSinceLastWake = (services: Services, automationId: string): SessionsSinceWake => {
    const entries = services.agents.ids().flatMap((id) => {
        const entry = services.agents.entry(id);
        return entry === undefined ? [] : [entry];
    });
    const ownWakes = entries.filter((entry) => firedBy(automationId, entry.id));
    const since = Math.max(0, ...ownWakes.map((entry) => entry.createdAt));
    const sessions = entries
        .filter(
            (entry) =>
                entry.createdAt > since &&
                entry.identity.origin === undefined &&
                !entry.id.startsWith(AUTOMATION_CONVERSATION_PREFIX) &&
                entry.totals.turns >= 1,
        )
        .sort((a, b) => b.createdAt - a.createdAt);
    return { since, sessions };
};

// How many counted sessions are listed by name; the count is the whole total, `agents ls --all` has the rest.
const SESSIONS_LISTED = 200;

// What a gated wake reads under its prompt: the count, when it was measured from, and the sessions, one per line.
// Persisted with the fire so a re-fire or replay reads the same list, not a fresh count.
const sessionsListing = ({ since, sessions }: SessionsSinceWake): string => {
    const measuredFrom =
        since === 0
            ? "and this automation has never woken an agent before"
            : `since ${new Date(since).toISOString()}, the last time this automation woke an agent`;
    const lines = sessions
        .slice(0, SESSIONS_LISTED)
        .map((session) =>
            [
                session.id,
                session.social.title?.text ?? "(untitled)",
                new Date(session.createdAt).toISOString(),
                `${session.totals.turns} turns`,
                `${session.totals.toolUses} tool uses`,
                `$${session.totals.costUsd.toFixed(2)}`,
            ].join(" · "),
        );
    const more = sessions.length > SESSIONS_LISTED ? [`… and ${sessions.length - SESSIONS_LISTED} more (agents ls --all)`] : [];
    return [`${sessions.length} sessions ${measuredFrom}. Newest first:`, ...lines, ...more].join("\n");
};

// One step of runFire: not gated or bar cleared returns the listing to carry as payload, cut at `cap`; short of the bar
// returns what the skipped run says.
export const sessionsGate = (services: Services, automation: AutomationRecord, cap: number): { readonly skipped: string } | { readonly listing?: string } => {
    const bar = automation.trigger.kind === "schedule" ? automation.trigger.afterSessions : undefined;
    if (bar === undefined) {
        return {};
    }
    const counted = sessionsSinceLastWake(services, automation.id);
    if (counted.sessions.length < bar) {
        return { skipped: `${counted.sessions.length} of ${bar} sessions since the last wake` };
    }
    return { listing: sessionsListing(counted).slice(0, cap) };
};
