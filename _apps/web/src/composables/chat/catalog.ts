import type { IconName } from "@intentic/ui";
import { type AgentCapabilities, type ModelBadge, modesFor, type PermissionMode } from "@intentic/sandbox-contract";
import type { ConversationStatus } from "./conversation";

/* Chat UI metadata shared by the desktop panel, the mobile header, and the menu bodies: the permission modes
 * and the small presentational helpers (tab status icon, relative time). The provider/harness/model catalog
 * lives in @intentic/sandbox-contract (agent-catalog.ts) — shared with the automations dialog; the live
 * per-provider model state, and the effort scale that is a property OF a model, live in conversation.ts. */

// How a capability badge renders in the model picker: icon-only chips, the label carried by the tooltip (three
// text chips per row would starve the description's space). The set is exactly the capability flags a provider
// reports (see ModelBadgeSchema) — vision/agentic badges existed here while badges were hand-assigned by id
// pattern, but no provider publishes those flags, so claiming them would have been our guess, not the truth.
export const BADGE_META: Record<ModelBadge, { label: string; icon: IconName }> = {
    reasoning: { label: `Reasoning`, icon: `sparkles` },
    fast: { label: `Fast`, icon: `bolt` },
};

/* How each permission mode reads in the selector. WHICH of them a conversation may pick is not decided here —
 * it is `modesFor(capabilities)` in the contract, because it is a property of the runtime rather than of the
 * menu. This split is the fix for the composer's oldest lie: the four modes were rendered unconditionally, so
 * "Ask before each file edit" sat above Codex, Grok and every ACP agent — none of which have an approval
 * channel at all, and each of which ran every tool call anyway. */
const MODE_META: Record<PermissionMode, { label: string; icon: IconName; description: string }> = {
    default: { label: `Manual`, icon: `question-circle`, description: `Ask before each file edit.` },
    acceptEdits: { label: `Edit automatically`, icon: `check-square`, description: `Apply file edits automatically.` },
    plan: { label: `Plan`, icon: `list-check`, description: `Propose a plan and wait for your approval before running.` },
    bypassPermissions: { label: `Auto`, icon: `forward`, description: `Run everything without asking.` },
};

export const modeMeta = (mode: PermissionMode): { label: string; icon: IconName; description: string } => MODE_META[mode];

// The modes this conversation's runtime can actually be put in, in the contract's order, dressed for the menu.
export const modeOptions = (capabilities: AgentCapabilities): { value: PermissionMode; label: string; icon: IconName; description: string }[] =>
    modesFor(capabilities).map((value) => {
        const meta = MODE_META[value];
        return { value, label: meta.label, icon: meta.icon, description: meta.description };
    });

// The postures a plan approval can land in, and how the plan card names them. 'plan' is absent by definition:
// approving is the exit FROM planning.
const APPROVALS: readonly { mode: PermissionMode; label: string }[] = [
    { mode: `acceptEdits`, label: `Yes, and auto-accept edits` },
    { mode: `bypassPermissions`, label: `Yes, and run everything` },
    { mode: `default`, label: `Yes, and approve each edit` },
];

// The plan card's approve buttons, primary first: the conversation's own posture leads, so approving a plan
// RESTORES it rather than demoting an agent that had full permissions to per-command prompts (planning is a
// move the agent makes on its own — it must not cost the user their pick). A conversation whose pick IS plan
// has nothing to restore, so auto-accepting edits leads there. The sort is stable, so the rest keep their order.
export const approvalsFor = (pick: PermissionMode): readonly { mode: PermissionMode; label: string }[] => {
    const restored: PermissionMode = pick === `plan` ? `acceptEdits` : pick;
    return APPROVALS.toSorted((left, right) => Number(right.mode === restored) - Number(left.mode === restored));
};

// The status icon classes for a conversation tab (live spinner / needs-input / error / idle dot).
export const statusIcon = (status: ConversationStatus): { name: IconName; spin?: boolean; class: string } => {
    if (status === `streaming`) {
        return { name: `spinner`, spin: true, class: `text-2xs text-link` };
    }
    if (status === `awaiting`) {
        return { name: `exclamation-circle`, class: `text-2xs text-primary-500` };
    }
    if (status === `error`) {
        return { name: `exclamation-triangle`, class: `text-2xs text-danger` };
    }
    return { name: `circle-fill`, class: `text-[0.5rem] text-subtle` };
};

// What statusIcon's glyph means, for the screen readers that can't see it.
export const statusLabel = (status: ConversationStatus): string => {
    if (status === `streaming`) {
        return `Working`;
    }
    if (status === `awaiting`) {
        return `Needs you`;
    }
    if (status === `error`) {
        return `Error`;
    }
    return `Idle`;
};

// Desktop tab title color by status — layered UNDER statusIcon's glyph rather than replacing it: colour alone
// is invisible to colourblind users and near-illegible on a truncated 2xs string.
export const statusTabClass = (status: ConversationStatus): string => {
    if (status === `streaming`) {
        return `text-link animate-pulse`;
    }
    if (status === `awaiting`) {
        return `text-primary-500`;
    }
    if (status === `error`) {
        return `text-danger`;
    }
    return ``;
};

// Compact relative time for the history list (e.g. "5m", "3h", "2d", else a short date).
export const relativeTime = (ms: number): string => {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60000);
    if (min < 1) {
        return `just now`;
    }
    if (min < 60) {
        return `${min}m`;
    }
    const hours = Math.round(min / 60);
    if (hours < 24) {
        return `${hours}h`;
    }
    const days = Math.round(hours / 24);
    if (days < 7) {
        return `${days}d`;
    }
    return new Date(ms).toLocaleDateString();
};
