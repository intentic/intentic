import type { IconName } from "@intentic/ui";
import { type AgentCapabilities, type ModelBadge, modesFor, type PermissionMode } from "@intentic/sandbox-contract";
import { agentStatusMeta } from "../../agents/fleet/agentStatus";
import type { ConversationStatus } from "../session/conversation";
import { t } from "@intentic/ui/i18n";

// Chat UI metadata shared across surfaces: permission modes and small presentational helpers (tab status icon,
// relative time). Model/provider/harness catalog lives in @intentic/sandbox-contract; live per-provider state
// and effort scale live in conversation.ts.

// Icon-only chips, label on the tooltip; the set matches the flags a provider actually reports.
export const badgeMeta = (): Record<ModelBadge, { label: string; icon: IconName }> => ({
    reasoning: { label: t(`chat.catalog.reasoning`), icon: `sparkles` },
    fast: { label: t(`chat.catalog.fast`), icon: `bolt` },
});

// How each mode reads in the selector; which modes a runtime may pick is `modesFor(capabilities)`, not here.
const modeTable = (): Record<PermissionMode, { label: string; icon: IconName; description: string }> => ({
    default: { label: t(`chat.catalog.manual`), icon: `question-circle`, description: t(`chat.catalog.askBeforeEachEdit`) },
    plan: { label: t(`chat.catalog.plan`), icon: `list-check`, description: t(`chat.catalog.proposePlanWaitApproval`) },
    bypassPermissions: { label: t(`chat.catalog.auto`), icon: `forward`, description: t(`chat.catalog.runEverythingWithoutAsking`) },
});

export const modeMeta = (mode: PermissionMode): { label: string; icon: IconName; description: string } => modeTable()[mode];

// The modes this conversation's runtime can actually be put in, in the contract's order, dressed for the menu.
export const modeOptions = (capabilities: AgentCapabilities): { value: PermissionMode; label: string; icon: IconName; description: string }[] =>
    modesFor(capabilities).map((value) => {
        const meta = modeMeta(value);
        return { value, label: meta.label, icon: meta.icon, description: meta.description };
    });

// The status icon classes for a conversation tab (live spinner / needs-input / error / idle dot).
// A tab's status glyph, bound straight onto an Icon.
export interface StatusGlyph {
    readonly name: IconName;
    readonly spin?: boolean;
    readonly class: string;
}

export const statusIcon = (status: ConversationStatus): StatusGlyph => {
    // An ending wears the board card's own glyph for it, so the tab and the card cannot draw one Stop two ways.
    if (status === `stopping` || status === `dismissing`) {
        const meta = agentStatusMeta(status);
        return { name: meta.icon, class: `text-2xs ${meta.class}` };
    }
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
    if (status === `stopping` || status === `dismissing`) {
        return agentStatusMeta(status).label;
    }
    if (status === `streaming`) {
        return t(`chat.catalog.working`);
    }
    if (status === `awaiting`) {
        return t(`shared.needs`);
    }
    if (status === `error`) {
        return t(`chat.catalog.error`);
    }
    return t(`chat.catalog.idle`);
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

