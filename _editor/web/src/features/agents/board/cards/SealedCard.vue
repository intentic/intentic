<!-- A PRIVATE CONVERSATION THE READER CANNOT READ, as the board draws it (schemas/seal.ts): a calendar's someone-else's
     event. Whose it is (their face and name), that it is private, where it stands and when it last moved, and its work
     once there is some, since that is the team's: the change count opens the review, and Land is offered to whoever lands.
     Never its title, an activity line or a model: the daemon sends none of them, and nothing here makes one up. Pressing
     it opens its gate in the chat's place (SealGate). AgentCard draws this in its own place for a sealed card. -->
<script setup lang="ts">
import { Avatar } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useTier } from "../../../../client/sandbox/useTier";
import { identityHue } from "../../../../lib/identityHue";
import { agentStandingMeta, cornerStandingShown } from "../../../../models/agent-status/agentStatus-meta";
import { laneOf } from "../../../../models/agent-status/agentStatus-lanes";
import { turnWorking } from "../../../../models/agent-status/agentStatus-standing";
import { fullName, sealAuthor, sealedTitle } from "../../../../models/agent-status/sealView";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import type { PendingAction } from "../laneDrop";
import AgentCardClock from "./AgentCardClock.vue";
import AgentCardWhen from "./AgentCardWhen.vue";
import { useCardClock } from "./cardClock";
import CardLandPresses from "./CardLandPresses.vue";
import { diffCount, diffTip } from "./cardPresses";
import type { CardFit } from "../view/boardGrid";

const t = useT();

// `fit`: how much of the card the board's width leaves room for (boardGrid.ts `CardFit`), as for every agent card.
const props = defineProps<{ agent: FleetAgent; dense?: boolean; selected?: boolean; pending?: PendingAction; fit?: CardFit }>();
const emit = defineEmits<{ open: [event?: MouseEvent]; changes: []; land: []; grab: [event: PointerEvent, card: HTMLElement] }>();

const author = computed(() => sealAuthor(props.agent.seal));
const lane = computed(() => laneOf(props.agent));
// The bigger card for work in flight, as every card in those lanes is (AgentCard `live`).
const live = computed(() => props.dense !== true && lane.value !== `finished`);
const meta = computed(() => agentStandingMeta(props.agent));
// A slim card keeps whose it is, its title and where it stands; the diff and the author's name go to the hover and the review.
const slim = computed(() => props.fit !== undefined && props.fit !== `full`);
const pad = computed(() => {
    if (props.fit === `tile`) {
        return `items-center px-1 py-2`;
    }
    if (slim.value) {
        return `gap-2 p-3`;
    }
    return live.value ? `gap-2.5 p-3.5` : `gap-2 p-3.5`;
});
const busy = computed(() => props.pending !== undefined);
const clock = useCardClock(() => props.agent, () => turnWorking(props.agent));
const landing = computed(() => props.pending === `land` || props.agent.status === `landing`);
const { canReview, canShip } = useTier();
const landPresses = computed(() => (props.agent.status === `ready` || props.agent.status === `landing`) && (canShip.value || canReview.value));
const diff = computed(() => {
    const changed = props.agent.diff;
    return changed !== undefined && (changed.insertions > 0 || changed.deletions > 0) ? changed : undefined;
});

// Dragged from its body as any card is, to land it by dropping it on Finished; a press on a button inside is that button's.
const grab = (event: PointerEvent): void => {
    if (event.button !== 0 || busy.value || !(event.currentTarget instanceof HTMLElement) || !(event.target instanceof Element)) {
        return;
    }
    if (event.target.closest(`button`) !== null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
    }
    emit(`grab`, event, event.currentTarget);
};
</script>

<template>
    <div
        role="group"
        :aria-label="sealedTitle()"
        class="session-card group flex w-full select-none flex-col rounded-2xl border text-left outline-none"
        :class="[pad, lane === 'attention' ? 'session-card-attention' : '', selected ? 'session-card-on' : '']"
        data-sealed-card
        @pointerdown="grab"
        @dragstart.prevent
        @click="emit(`open`, $event)"
    >
        <!-- A tile card is the face alone, whose it is and that it is sealed in its hover. -->
        <button
            v-if="fit === `tile`"
            type="button"
            class="rounded-full"
            v-tooltip.right="`${fullName(author)} · ${sealedTitle()}`"
            :aria-label="t(`agents.sealedCard.open`, { name: fullName(author) })"
            @click.stop="emit(`open`, $event)"
        >
            <Avatar :size="28" :name="fullName(author)" :hue="identityHue(author?.email ?? agent.id)" />
        </button>
        <!-- A mini card's title goes under the face, where it has the card's width rather than a word's. -->
        <div v-else class="flex items-center gap-x-2.5" :class="fit === `mini` ? 'flex-wrap gap-y-1.5' : ''">
            <!-- Whose it is, by their face: what a reader recognises first, and who to ask. -->
            <Avatar :size="22" :name="fullName(author)" :hue="identityHue(author?.email ?? agent.id)" class="shrink-0 self-start" />
            <button
                type="button"
                class="inline-flex min-w-0 flex-1 basis-0 gap-1.5 rounded-sm text-left italic text-muted text-xs"
                :class="[slim ? 'items-start' : 'items-center', fit === `mini` ? 'basis-full' : '']"
                :aria-label="t(`agents.sealedCard.open`, { name: fullName(author) })"
                @click.stop="emit(`open`, $event)"
            >
                <Icon name="lock" class="shrink-0 text-2xs not-italic" />
                <span :class="slim ? 'line-clamp-3 break-words' : 'truncate'">{{ sealedTitle() }}</span>
            </button>
            <!-- Where it stands, in the corner every card keeps it in: the glyph and its word; a slim card's, under its title. -->
            <span v-if="!slim && cornerStandingShown(agent.status)" class="ml-auto inline-flex shrink-0 items-center gap-1 text-2xs font-medium" :class="meta.class">
                <Icon :name="meta.icon" :spin="meta.spin" class="text-xs" />{{ meta.label }}
            </span>
        </div>

        <div v-if="slim && fit !== `tile`" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-subtle">
            <AgentCardWhen :agent="agent" :clock="clock" :activity-text="undefined" />
            <span v-if="cornerStandingShown(agent.status)" class="ml-auto inline-flex min-w-0 items-center gap-1 font-medium" :class="meta.class">
                <Icon :name="meta.icon" :spin="meta.spin" class="text-xs" /><span class="truncate">{{ meta.label }}</span>
            </span>
        </div>
        <div v-else-if="!slim" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-subtle">
            <span class="min-w-0 truncate text-muted">{{ fullName(author) }}</span>
            <!-- Its work is shared: the count and the way to the review, as on every card with a diff. -->
            <button
                v-if="diff !== undefined"
                type="button"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-sm hover:underline"
                :aria-label="t(`agents.agentCard.viewChangesCount`, { added: diff.insertions, removed: diff.deletions })"
                v-tooltip.top="diffTip(diff)"
                @click.stop="emit(`changes`)"
            >
                <span class="font-mono tabular-nums"><span class="text-success">+{{ diffCount(diff.insertions) }}</span> <span class="text-danger">−{{ diffCount(diff.deletions) }}</span></span>
                <span>·</span>
                <span class="font-medium text-link">{{ t(`agents.sealedCard.reviewDiff`) }}</span>
            </button>
            <span class="ml-auto inline-flex min-w-max items-center justify-end gap-2">
                <AgentCardWhen :agent="agent" :clock="clock" :activity-text="undefined" />
                <AgentCardClock :clock="clock" :busy="busy" />
            </span>
        </div>

        <CardLandPresses v-if="landPresses && (fit === undefined || fit === `full` || fit === `compact`)" :agent="agent" :title="sealedTitle()" :busy="busy" :landing="landing" @land="emit(`land`)" />
    </div>
</template>
