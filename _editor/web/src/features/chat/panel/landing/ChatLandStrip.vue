<!-- THIS CHAT'S UNLANDED WORK AND ITS PRESS, just above the composer where the eye goes after the last reply: the board
     card's Land now (or a collaborator's Request land), so a reader who opened the chat instead of landing it from the
     board lands it here, without going back. What it shows and when is landStrip.ts's. -->
<script setup lang="ts">
import { Button, type Tip, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useAudience } from "../../../../app/useAudience";
import { here, page } from "../../../../lib/routes/links";
import { useRole } from "../../../../client/sandbox/useRole";
import { attentionReason, reviewAction } from "../../../../models/agent-status/agentStatus-attention";
import { agentDisplayTitle } from "../../../../models/agent-status/agentStatus-meta";
import { landFromMenu } from "../../../../models/fleet/presses/landPress";
import { pendingOn } from "../../../../models/fleet/useAgents-provisional";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import { navigateInApp } from "../../../../workbench/window/mainWindow";
import AgentLandPress from "../../../../parts/fleet/AgentLandPress.vue";
import { useCardRequests } from "../../../../models/fleet/presses/cardRequests";
import type { LandStrip } from "./landStrip";
import HandsOffOffer from "./HandsOffOffer.vue";

const props = defineProps<{ agent: FleetAgent; strip: LandStrip }>();

const t = useT();
const words = useVocabulary();
const router = useRouter();
const { canShip } = useRole();
const { maker } = useAudience();
const { mobile } = useDevice();

// The collaborator's ask goes to the daemon the way the board card's does, held in the same ledger entry, so a press
// here and one on the card or the review page hold each other.
const { requesting, requestLand } = useCardRequests(
    () => props.agent,
    () => agentDisplayTitle(props.agent),
);

// The review page, where the whole diff is read and a refused land is sorted out; from a popped-out chat it opens in the
// main window (navigateInApp).
const openReview = (): void => navigateInApp(router, here(page.agent(props.agent.id)));

// The card's own land: a refusal is said as a toast, since no board strip is here to carry it (landFromMenu).
const land = (): void => void landFromMenu(props.agent, `land`);

const landDisabled = computed(() => pendingOn(props.agent.id, props.agent.sandboxId) !== undefined);
const landHint = computed((): Tip => ({ title: t(`agents.agentDetail.toWorkspace`) }));
const requestHint = computed((): Tip => ({ title: t(`agents.agentDetail.needsMaintainer`), note: t(`agents.agentDetail.asksOnTheirBoard`) }));

// The diff is a developer's fact, as on the board card; plain words say only that it is ready.
const diff = computed(() => (props.strip.kind === `ready` && !maker.value ? props.strip.diff : undefined));
// A refused land, in the board card's own words: its corner's chip ("Land conflict", or "Your edits" when the reader's
// own uncommitted files refused it) and its drill-in's verb.
const conflict = computed(() => ({
    chip: attentionReason(props.agent) ?? t(`agents.agentStatus.landConflict`),
    verb: reviewAction(props.agent) ?? t(`agents.agentStatus.seeWhatBlocked`),
}));
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-card px-3 py-2 text-2xs shadow-sm" role="status" data-land-strip>
        <template v-if="strip.kind === `ready`">
            <span class="flex min-w-0 flex-1 items-center gap-2">
                <Icon name="check" class="shrink-0 text-success" />
                <span class="font-medium text-content">{{ words.readyToLand }}</span>
                <span v-if="diff !== undefined" class="flex min-w-0 items-center gap-1.5 truncate text-muted">
                    <span>{{ t(`chat.chatLandStrip.files`, { count: diff.files }, diff.files) }}</span>
                    <span class="tabular-nums text-success">+{{ diff.insertions }}</span>
                    <span class="tabular-nums text-danger">−{{ diff.deletions }}</span>
                </span>
            </span>
            <!-- A phone gives the two presses equal halves at thumb height; AgentLandPress's own block form fills its half. -->
            <span :class="mobile ? `grid w-full grid-cols-2 gap-2` : `flex shrink-0 items-center gap-1.5`">
                <Button :size="mobile ? undefined : `small`" :thumb="mobile" tier="boring" class="whitespace-nowrap" @click="openReview">{{
                    words.review
                }}</Button>
                <AgentLandPress
                    :can-ship="canShip"
                    :agent="agent"
                    :land-disabled="landDisabled"
                    :requesting="requesting"
                    :land-hint="landHint"
                    :request-hint="requestHint"
                    :block="mobile"
                    @land="land"
                    @request="requestLand"
                />
            </span>
            <!-- Under work that waits for a press: the one time letting the sandbox take such presses over is worth asking. -->
            <HandsOffOffer />
        </template>
        <span v-else-if="strip.kind === `landing`" class="flex min-w-0 items-center gap-2 text-muted">
            <Icon name="spinner" spin class="shrink-0 text-link" />
            <span class="font-medium text-content">{{ words.landing }}</span>
        </span>
        <template v-else>
            <span class="flex min-w-0 flex-1 items-center gap-2">
                <Icon name="exclamation-triangle" class="shrink-0 text-warning" />
                <span class="font-medium text-content">{{ conflict.chip }}</span>
            </span>
            <!-- The one way on from a refused land: its review, where the conflict is read and fixed. -->
            <Button size="small" tier="accent" class="shrink-0 whitespace-nowrap" @click="openReview">{{ conflict.verb }}</Button>
        </template>
    </div>
</template>
