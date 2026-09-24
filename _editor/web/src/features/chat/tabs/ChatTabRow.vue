<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { boxNameOf } from "../../agents/fleet/fleetScope";
import { turnInFlight } from "../../agents/fleet/agentStatus";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import OriginMark from "../../../components/OriginMark.vue";
import RailCard from "../../../components/RailCard.vue";
import UnsentMark from "../../../components/UnsentMark.vue";
import WorkflowMark from "../../../components/WorkflowMark.vue";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import { viewersOfSession } from "../../../shell/presence/usePresence";
import { relativeTime } from "../models/catalog";
import { draftPreview } from "../drafts/draftPreview";
import type { Conversation } from "../session/conversation";
import type { CardView } from "./cardView";
import { isArchived, originOf, tabLabel } from "./tabs";

// One open chat as the rail draws it. A component rather than a block of ChatTabList's template because the card is
// named by its own composer while nothing else has named it (tabLabel → draftPreview): read from the list, that one
// draft would put the whole lane's render — every other card's vnodes, and the lane's own header and Clear — on every
// keystroke, since a slot's reactive reads belong to the component that invokes it. Read here, a keystroke redraws
// the row it was typed into.

const t = useT();

const props = defineProps<{
    conversation: Conversation;
    // The roster's entry for this chat, absent for one it hasn't filed (archived, unregistered, another window's).
    agent?: FleetAgent;
    // Everything derived, built once per pass by the list and held while its fields are value-equal (cardView.ts).
    view: CardView;
    needle?: string;
    matchCase?: boolean;
    // True when this chat is the focused one or holds a column.
    selected: boolean;
    // True for a row in the Attention lane: the card's left-edge bar.
    attention: boolean;
    // Whether the × is offered at all; the last open chat keeps no close affordance.
    closable: boolean;
}>();

const emit = defineEmits<{
    select: [event: MouseEvent];
    rename: [];
    menu: [event: Event];
    hover: [event: MouseEvent];
    leave: [];
    close: [];
    keep: [];
    middleClose: [];
}>();

// The × and the pin sit inside the card's click target; stop propagation or the press also selects the row.
// Spelled out per verb: `emit` is an overload set, and a union argument matches none of them.
const act = (event: Event, verb: "close" | "keep"): void => {
    event.stopPropagation();
    if (verb === `close`) {
        emit(`close`);
        return;
    }
    emit(`keep`);
};
</script>

<template>
    <RailCard
        :data-chat-tab="props.conversation.conversationId"
        :title="tabLabel(props.conversation)"
        :title-action="props.agent?.titleAction"
        :needle="props.needle"
        :match-case="props.matchCase"
        :provider="props.agent?.provider ?? props.conversation.selection.provider.value"
        :status="props.view.status"
        :chip="props.view.chip"
        :rim="props.view.rim"
        :live="props.view.live"
        tight
        :selected="props.selected"
        :peek="props.conversation.peek.value"
        :attention="props.attention"
        :snippet="props.view.snippet"
        v-middleclick="() => emit('middleClose')"
        @click="emit('select', $event)"
        @dblclick.prevent.stop="emit('rename')"
        @contextmenu.prevent.stop="emit('menu', $event)"
        @mouseenter="emit('hover', $event)"
        @mouseleave="emit('leave')"
    >
        <template #trailing>
            <PresenceAvatars
                v-if="props.conversation.session.value !== undefined"
                :members="viewersOfSession(props.conversation.session.value!.id)"
                :label="t(`shared.inChat`)"
            />
            <!-- The × is a hit target around an 11px glyph; a miss lands on the card and re-selects it. -->
            <!-- The peeked card keeps its pin action in the trailing slot. -->
            <span
                v-if="props.conversation.peek.value"
                role="button"
                :aria-label="t(`shared.keepChatOpen`)"
                v-tooltip.top="t(`shared.keepOpenOtherwiseChat`)"
                class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click="act($event, `keep`)"
            >
                <Icon name="pin" class="text-2xs" />
            </span>
            <span
                v-else-if="props.closable"
                role="button"
                :aria-label="t(`shared.closeChat`)"
                class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                @click="act($event, `close`)"
            >
                <Icon name="times" class="text-2xs" />
            </span>
        </template>
        <!-- One line: where it came from, the model, and (settled only) its age, right-aligned. Why it needs you is the card's corner (see `chipOf`), where the board puts it too. -->
        <template v-if="props.view.meta" #meta>
            <UnsentMark
                v-if="props.conversation.unsent.value"
                :preview="draftPreview(props.conversation.draft.value)"
                :at="props.conversation.draftAt.value"
            />
            <!-- One glyph, no countdown: the rail says which chat is about to stop being cheap to answer, the board says for how long. -->
            <Icon
                v-if="props.view.warm !== undefined"
                :name="props.view.warm.icon"
                class="shrink-0 text-2xs"
                :class="props.view.warm.cold ? 'text-warning' : 'text-link'"
                v-tooltip.top="props.view.warm.hint"
            />
            <Icon
                v-else-if="props.view.cooling !== undefined"
                name="bolt"
                class="shrink-0 text-2xs"
                :class="props.view.cooling.near ? 'text-link' : 'text-muted'"
                v-tooltip.top="props.view.cooling.hint"
            />
            <!-- Provenance marks (external origin, workflow), same as the board's OriginMark in the card body. -->
            <OriginMark :origin="originOf(props.conversation)" compact />
            <WorkflowMark :workflow="props.agent?.workflow" compact />
            <!-- Chats in another sandbox identify that sandbox in metadata. -->
            <span
                v-if="props.conversation.box.value !== undefined"
                v-tooltip.top="
                    t(`chat.chatTabList.runsInQuoted`, {
                        sandbox: boxNameOf.get(props.conversation.box.value!) ?? t(`chat.chatTabList.anotherSandbox`),
                    })
                "
                class="flex shrink-0 items-center"
                :aria-label="
                    t(`chat.chatTabList.runsIn`, {
                        sandbox: boxNameOf.get(props.conversation.box.value!) ?? t(`chat.chatTabList.anotherSandbox`),
                    })
                "
            >
                <Icon name="boxes" class="text-2xs text-subtle" />
            </span>
            <span v-if="isArchived(props.conversation)" class="flex shrink-0 items-center" :aria-label="t(`shared.archived`)">
                <Icon name="box" class="text-2xs text-subtle" />
            </span>
            <!-- Spend, diff and turn count are deliberately absent here; they live on the board and Usage tab. -->
            <span v-if="props.view.model !== undefined" class="max-w-24 truncate">{{ props.view.model }}</span>
            <!-- Age is shown only when settled; a running card's clock is the live line's elapsed readout instead. -->
            <span v-if="props.agent !== undefined && !turnInFlight(props.agent) && props.agent.updatedAt > 0" class="ml-auto shrink-0">{{
                relativeTime(props.agent.updatedAt)
            }}</span>
        </template>
    </RailCard>
</template>
