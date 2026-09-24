import type { IconName } from "@intentic/ui";
import { type MatchSnippet, providerLabel } from "@intentic/sandbox-contract";
import { sessionCategory } from "../../../app/sessionCategory";
import {
    activityIcon,
    activityLine,
    agentStatusMeta,
    type StandingChip,
    standingChip,
    type TileRim,
    tileRim,
    turnInFlight,
} from "../../agents/fleet/agentStatus";
import { type CacheCooling, cacheCooling, type WarmMark, warmMark } from "../../agents/fleet/promptCache";
import { snapshotFingerprint } from "../../agents/fleet/useAgents-registry";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { modelLabelFor } from "../accounts/providerCatalog";
import { statusIcon, statusLabel } from "../models/catalog";
import type { Conversation } from "../session/conversation";
import { isArchived, originOf, tabLabel } from "./tabs";
import { t } from "@intentic/ui/i18n";

// Everything a rail row is handed that isn't a primitive, derived in one place per card. Kept apart from the list
// that draws it because a row compares its props by identity: the rule that decides when a card's facts are the SAME
// facts is what stops a pass over the lane from redrawing every row in it, and it is worth reading on its own.

export interface OpenChat {
    readonly conversation: Conversation;
    readonly agent: FleetAgent | undefined;
}

export interface CardView {
    readonly status: { name: IconName; spin?: boolean; class: string; "aria-label": string };
    readonly chip: StandingChip | undefined;
    readonly rim: TileRim | undefined;
    readonly live: { icon: IconName; text: string; since: number | undefined } | undefined;
    readonly snippet: MatchSnippet | undefined;
    readonly model: string | undefined;
    // The board's cooling chip at rail width: the glyph and its sentence, without the countdown, since a second clock
    // beside the title would read as the turn's own.
    readonly cooling: CacheCooling | undefined;
    // A hold on the cache outranks the cooling glyph; the open chat's status bar is where it is changed.
    readonly warm: WarmMark | undefined;
    readonly meta: boolean;
}

// Status glyph for the trailing slot: agent status when fleet-carded, else the conversation's own status. Returned
// pre-bound as one object so the row computes it once, not per-field.
const statusOf = (entry: OpenChat): CardView[`status`] => {
    if (entry.agent !== undefined) {
        const meta = agentStatusMeta(entry.agent.status);
        return { name: meta.icon, spin: meta.spin, class: `text-xs ${meta.class}`, "aria-label": meta.label };
    }
    const status = entry.conversation.status.value;
    const icon = statusIcon(status);
    return { name: icon.name, spin: icon.spin, class: `text-xs ${icon.class}`, "aria-label": statusLabel(status) };
};

// Model label as the pickers show it; falls back to the provider name when no model is recorded yet. `activeModel` is
// what last ran; `model` is what the composer would send next.
const modelOf = (entry: OpenChat): string | undefined => {
    const { agent, conversation } = entry;
    const provider = agent?.provider ?? conversation.selection.provider.value;
    const model = agent?.model ?? conversation.activeModel.value ?? conversation.selection.model.value;
    if (model !== null && model !== ``) {
        return modelLabelFor(provider, model);
    }
    return sessionCategory(tabLabel(conversation), agent?.titleAction) === undefined ? undefined : providerLabel(provider);
};

// Live-line text prefers the registry's activity frames (richer); falls back to the conversation's own streaming state
// so a working card stays findable even when the fleet join is cold.
const liveOf = (entry: OpenChat): CardView[`live`] => {
    const { agent, conversation } = entry;
    if (agent !== undefined && turnInFlight(agent)) {
        return {
            icon: (agent.subagents?.running ?? 0) > 0 ? `users` : activityIcon(agent.activity?.tool),
            text: activityLine(agent) ?? t(`shared.working`),
            since: agent.startedAt,
        };
    }
    if (conversation.turn.streaming.value) {
        return { icon: activityIcon(undefined), text: t(`shared.working`), since: conversation.turn.turnStartedAt.value };
    }
    return undefined;
};

// Whether the second line has anything to show; a fresh draft has no numbers, marks or model, so it's asked per card
// rather than assumed. The standing is not counted here: it wears the card's corner, not this line.
const hasMeta = (entry: OpenChat): boolean =>
    (entry.agent !== undefined && entry.agent.updatedAt > 0) ||
    entry.conversation.unsent.value ||
    originOf(entry.conversation) !== undefined ||
    isArchived(entry.conversation) ||
    modelOf(entry) !== undefined;

export interface CardViews {
    /** This card's view model, the held one when its fields are value-equal to the last pass. */
    readonly of: (entry: OpenChat, snippet: MatchSnippet | undefined, now: number) => CardView;
    /** Drops every card no longer drawn; call once per pass, after building them all. */
    readonly prune: (alive: ReadonlySet<string>) => void;
}

/**
 * Per-list view models, held while their fields are value-equal: a row compares its props by identity, so a fresh
 * object for unchanged facts redraws every row in the lane on any pass — and a pass is as cheap as a keystroke. One
 * cache per list rather than one per module, since two lists (docked and floating) filter separately and would
 * otherwise evict each other's snippets.
 */
export const createCardViews = (): CardViews => {
    const held = new Map<string, { print: string; view: CardView }>();
    return {
        of: (entry, snippet, now) => {
            const view: CardView = {
                status: statusOf(entry),
                // The corner's word, from the board's own projection: why this chat needs you, else that it worked
                // since you last looked. A conversation the roster hasn't filed has no standing to report, so its
                // corner keeps the status glyph. The rim and the cooling chip are absent for the same reason.
                chip: entry.agent === undefined ? undefined : standingChip(entry.agent),
                rim: entry.agent === undefined ? undefined : tileRim(entry.agent, { quiet: false }),
                live: liveOf(entry),
                snippet,
                model: modelOf(entry),
                cooling: entry.agent === undefined ? undefined : cacheCooling(entry.agent, now),
                warm: entry.agent === undefined || turnInFlight(entry.agent) ? undefined : warmMark(entry.agent),
                meta: hasMeta(entry),
            };
            const print = snapshotFingerprint(view);
            const previous = held.get(entry.conversation.conversationId);
            if (previous?.print === print) {
                return previous.view;
            }
            held.set(entry.conversation.conversationId, { print, view });
            return view;
        },
        prune: (alive) => {
            for (const id of held.keys()) {
                if (!alive.has(id)) {
                    held.delete(id);
                }
            }
        },
    };
};
