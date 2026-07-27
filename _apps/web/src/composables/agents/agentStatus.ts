import type { IconName } from "@intentic-app/ui";
import type { AgentOrigin, AgentStatus } from "@intentic/sandbox-contract";

/* Presentational metadata for fleet-agent statuses + the card's number formatters. Extends the conversation
 * status idiom (catalog.ts statusIcon) with the registry-only outcomes (landed / conflict) and the
 * client-only `draft` (an open isolated conversation that hasn't run its first turn); kept separate because
 * the fleet renders the widened FleetAgent status, not ConversationStatus (the live-stream union). */

export const agentStatusMeta = (status: AgentStatus | "draft"): { icon: IconName; spin?: boolean; label: string; class: string } => {
    // Not `pencil` — that's the card's rename affordance; the draft glyph is a not-yet-started marker.
    if (status === `draft`) {
        return { icon: `circle`, label: `Draft`, class: `text-subtle` };
    }
    if (status === `running`) {
        return { icon: `spinner`, spin: true, label: `Running`, class: `text-link` };
    }
    if (status === `awaiting`) {
        return { icon: `exclamation-circle`, label: `Needs you`, class: `text-primary-500` };
    }
    if (status === `landed`) {
        return { icon: `check-circle`, label: `Landed`, class: `text-success` };
    }
    if (status === `conflict`) {
        return { icon: `exclamation-triangle`, label: `Conflict`, class: `text-warning` };
    }
    if (status === `error`) {
        return { icon: `exclamation-triangle`, label: `Error`, class: `text-danger` };
    }
    return { icon: `circle-fill`, label: `Idle`, class: `text-subtle` };
};

// The sources an agent can be OPENED BY, when it wasn't opened by the user: the label and glyph the card's
// provenance line wears. Keyed by AgentOrigin.provider, which is an open string (listener sources are
// extension-declared), so an unknown one degrades to its own name rather than disappearing.
const ORIGIN_SOURCES: Record<string, { icon: IconName; label: string }> = {
    discord: { icon: `comments`, label: `Discord` },
    imap: { icon: `envelope`, label: `Email` },
    webchat: { icon: `globe`, label: `Web chat` },
    webhook: { icon: `bolt`, label: `Webhook` },
};

// The card's "this conversation came in from outside" line: what opened it, who sent it, and — in the tooltip
// — which automation was configured to answer. The user never typed this agent's first message, and a card
// that doesn't say so reads as an agent they forgot starting.
export const originMeta = (origin: AgentOrigin): { icon: IconName; label: string; detail: string | undefined; hint: string } => {
    const source = ORIGIN_SOURCES[origin.provider] ?? { icon: `wave-pulse` as IconName, label: origin.provider };
    const where = origin.channelId !== undefined ? ` in ${origin.channelId}` : ``;
    const who = origin.author !== undefined ? ` from ${origin.author}` : ``;
    return {
        icon: source.icon,
        label: source.label,
        detail: origin.author,
        hint: `Started by the "${origin.automationId}" automation for a ${source.label} message${who}${where} — its first prompt is the automation's, not yours.`,
    };
};

// Dollars with sensible precision: sub-cent turns still show something, big totals stay short.
export const formatCost = (usd: number): string => (usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

export const formatTokens = (tokens: number): string =>
    tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(0)}k` : `${tokens}`;

// Elapsed readout for a running turn's startedAt (ms since epoch).
export const formatElapsed = (startedAt: number, now: number): string => {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

// Context-window fill percentage (0–100), clamped; undefined when either side is unknown.
export const contextPct = (tokens: number | undefined, window: number | undefined): number | undefined =>
    tokens === undefined || window === undefined || window === 0 ? undefined : Math.min(100, Math.round((tokens / window) * 100));

// The one-line "why this card is in the Attention lane" label — shared by the card chip and any future toast.
export const attentionReason = (agent: {
    readonly status: AgentStatus | "draft";
    readonly attention: { plan: boolean; question: boolean; conflict: boolean };
}): string | undefined => {
    if (agent.attention.plan) {
        return `Approval needed`;
    }
    if (agent.attention.question) {
        return `Question for you`;
    }
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `Land conflict`;
    }
    if (agent.status === `error`) {
        return `Error`;
    }
    return undefined;
};

// The card's drill-in affordance label (desktop) — the verb that names what the review detail opens onto, so
// the button reads as a destination rather than a generic "open". A DRAFT has no worktree/diff yet, so it has
// no review detail (returns undefined): its click only focuses the docked chat. Everything registered has a
// destination; the label leads with why-you'd-go — pending approval/question first, then a land conflict or
// error, then a diff to look over, falling back to a plain "Review" for a running agent with nothing yet.
export const reviewAction = (agent: {
    readonly status: AgentStatus | "draft";
    readonly attention: { plan: boolean; question: boolean; permission: boolean; conflict: boolean };
    readonly diff?: { files: number };
}): string | undefined => {
    if (agent.status === `draft`) {
        return undefined;
    }
    if (agent.attention.plan) {
        return `Review plan`;
    }
    if (agent.attention.question) {
        return `Answer`;
    }
    if (agent.attention.permission) {
        return `Approve`;
    }
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `Resolve conflict`;
    }
    if (agent.status === `error`) {
        return `View error`;
    }
    if (agent.diff !== undefined && agent.diff.files > 0) {
        return `Review changes`;
    }
    return `Review`;
};

// The activity line's icon by tool family — a glanceable "what is it doing" glyph, mock-style.
export const activityIcon = (tool: string | undefined): IconName => {
    if (tool === undefined) {
        return `list-check`; // a todo line without a tool
    }
    if (tool === `Edit` || tool === `Write` || tool.startsWith(`mcp__hashline`)) {
        return `pencil`;
    }
    if (tool === `Bash` || tool === `BashOutput`) {
        return `code`;
    }
    if (tool === `Read`) {
        return `file`;
    }
    if (tool === `Grep` || tool === `Glob` || tool.includes(`search`)) {
        return `search`;
    }
    return `sparkles`;
};
