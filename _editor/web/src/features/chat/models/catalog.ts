import type { IconName } from "@intentic/ui";
import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { ModelBadge } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { modesFor } from "@intentic/sandbox-contract/models/agent-catalog";
import type { PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import { localFace } from "../../../app/environments/local";
import { agentStatusMeta } from "../../../models/agent-status/agentStatus-meta";
import type { ConversationStatus } from "../../../models/conversations/session/conversation";
import { t } from "@intentic/ui/i18n";

// Chat UI metadata shared across surfaces: permission modes and small presentational helpers (tab status icon,
// relative time). Model/provider/harness catalog lives in @intentic/sandbox-contract; live per-provider state
// and effort scale live in conversation.ts.

// Icon-only chips, label on the tooltip; the set matches the flags a provider actually reports.
export const badgeMeta = (): Record<ModelBadge, { label: string; icon: IconName }> => ({
    reasoning: { label: t(`chat.catalog.reasoning`), icon: `sparkles` },
    fast: { label: t(`chat.catalog.fast`), icon: `bolt` },
});

type ModeTable = Record<PermissionMode, { label: string; icon: IconName; description: string }>;

// How each mode reads in the selector; which modes a runtime may pick is `modesFor(capabilities)`, not here.
const sandboxModes = () =>
    ({
        default: { label: t(`chat.catalog.manual`), icon: `question-circle`, description: t(`chat.catalog.askBeforeEachEdit`) },
        plan: { label: t(`chat.catalog.plan`), icon: `list-check`, description: t(`chat.catalog.proposePlanWaitApproval`) },
        bypassPermissions: { label: t(`chat.catalog.auto`), icon: `forward`, description: t(`chat.catalog.runEverythingWithoutAsking`) },
    }) satisfies ModeTable;

// The same three, as they read for an agent that runs on this computer itself (local/agents/, _devices/host-agents).
// A sandbox's third mode runs everything without asking, because the container is what holds the agent; nothing holds
// one here, so the furthest that mode goes is file edits without a card each, with a command still asked about, and it
// is worded as that. The first is the default there and says what it does rather than "Manual".
const computerModes = () =>
    ({
        default: { label: t(`chat.computer.mode.ask`), icon: `question-circle`, description: t(`chat.computer.mode.askNote`) },
        plan: { label: t(`chat.catalog.plan`), icon: `list-check`, description: t(`chat.computer.mode.planNote`) },
        bypassPermissions: { label: t(`chat.computer.mode.acceptEdits`), icon: `pencil`, description: t(`chat.computer.mode.acceptEditsNote`) },
    }) satisfies ModeTable;

/** How each mode reads, in a sandbox or (`computer`) for an agent on this computer itself. Pure but for the catalog. */
export const modeTableFor = (computer: boolean): ModeTable => (computer ? computerModes() : sandboxModes());

// A desktop window on a folder has no sandbox behind it: every chat it draws is with an agent on this computer.
export const modeMeta = (mode: PermissionMode): { label: string; icon: IconName; description: string } => modeTableFor(localFace() !== undefined)[mode];

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
    // The card corner's ink for the same ask (agentStatusMeta): info blue, apart from a working gold.
    if (status === `awaiting`) {
        return { name: `exclamation-circle`, class: `text-2xs text-info` };
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


