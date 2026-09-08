import type { IconName } from "@intentic/ui";
import { formatDate } from "@intentic/ui/format";
import { type AgentCapabilities, type ModelBadge, modesFor, type PermissionMode } from "@intentic/sandbox-contract";
import type { ConversationStatus } from "../session/conversation";

// Chat UI metadata shared across surfaces: permission modes and small presentational helpers (tab status icon,
// relative time). Model/provider/harness catalog lives in @intentic/sandbox-contract; live per-provider state
// and effort scale live in conversation.ts.

// Icon-only chips, label on the tooltip; the set matches the flags a provider actually reports.
export const BADGE_META: Record<ModelBadge, { label: string; icon: IconName }> = {
    reasoning: { label: `Reasoning`, icon: `sparkles` },
    fast: { label: `Fast`, icon: `bolt` },
};

// How each mode reads in the selector; which modes a runtime may pick is `modesFor(capabilities)`, not here.
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

// Desktop tab title colour by status, layered under statusIcon's glyph, not replacing it (colour alone fails
// colourblind/truncated text). Colour only, no pulse: the spinner already animates.
export const statusTabClass = (status: ConversationStatus): string => {
    if (status === `streaming`) {
        return `text-link`;
    }
    if (status === `awaiting`) {
        return `text-primary-500`;
    }
    if (status === `error`) {
        return `text-danger`;
    }
    return ``;
};

// Compact relative time ("5m", "3h", "2d", else a date). Pass `now` when the caller holds a tick (board
// cards, chat rail); otherwise a still component's age freezes at first render.
export const relativeTime = (ms: number, now = Date.now()): string => {
    const diff = now - ms;
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
    return formatDate(ms);
};
