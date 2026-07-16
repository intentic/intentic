import type { IconName } from "@intentic-app/ui";
import type { AgentProvider, CatalogOption } from "@intentic/sandbox-contract";
import type { ChatMode, ConversationStatus } from "./conversation";

/* Chat UI metadata shared by the desktop panel, the mobile header, and the menu bodies: the effort catalog,
 * the permission modes, and the small presentational helpers (tab status icon, relative time). The provider/
 * harness/model catalog lives in @intentic/sandbox-contract (agent-catalog.ts) — shared with the automations
 * dialog. Pure data + pure functions — all live state stays in the useChat singleton. */

// Reasoning effort levels (SDK EffortLevel); 'xhigh' is the default in useChat. Codex's scale ends at xhigh.
export const effortsFor = (provider: AgentProvider): CatalogOption[] => [
    { label: `Low`, value: `low` },
    { label: `Medium`, value: `medium` },
    { label: `High`, value: `high` },
    { label: `X-High`, value: `xhigh` },
    ...(provider === `claude` ? [{ label: `Max`, value: `max` }] : []),
];

// Permission modes for the composer's mode selector; value mirrors the SDK permissionMode. 'plan' is default.
export const MODES: readonly { value: ChatMode; label: string; icon: IconName; description: string }[] = [
    { value: `default`, label: `Manual`, icon: `question-circle`, description: `Ask before each file edit.` },
    { value: `acceptEdits`, label: `Edit automatically`, icon: `check-square`, description: `Apply file edits automatically.` },
    { value: `plan`, label: `Plan`, icon: `list-check`, description: `Propose a plan and wait for your approval before running.` },
    { value: `bypassPermissions`, label: `Auto`, icon: `forward`, description: `Run everything without asking.` },
];

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

// Desktop tab title color by status (icon-free; streaming pulses to signal "working").
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
