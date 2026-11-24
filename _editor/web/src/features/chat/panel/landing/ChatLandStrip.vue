<!-- THIS CHAT'S UNLANDED WORK AND ITS PRESS, just above the composer where the eye goes after the last reply: the board
     card's Land now (or a collaborator's Request land), so a reader who opened the chat instead of landing it from the
     board lands it here, without going back. What it shows and when is landStrip.ts's. -->
<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useAudience } from "../../../../app/useAudience";
import { here, page } from "../../../../lib/routes/links";
import { useTier } from "../../../../client/sandbox/useTier";
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
import ChatDockRow from "../dock/ChatDockRow.vue";
import { useDockLit } from "../dock/dockLit";

const props = defineProps<{ agent: FleetAgent; strip: LandStrip }>();

const t = useT();
const words = useVocabulary();
const router = useRouter();
const { canShip } = useTier();
const { maker } = useAudience();
const lit = useDockLit();

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
// In plain words, a maintainer gets one sentence explaining what accepting does before the buttons.
const explanation = computed(() => (props.strip.kind === `ready` && maker.value && canShip.value ? t(`workspace.results.acceptExplanation`) : undefined));
// A refused land, in the board card's own words: its corner's chip ("Land conflict", or "Your edits" when the reader's
// own uncommitted files refused it) and its drill-in's verb.
const conflict = computed(() => ({
    chip: attentionReason(props.agent) ?? t(`agents.agentStatus.landConflict`),
    verb: reviewAction(props.agent) ?? t(`agents.agentStatus.seeWhatBlocked`),
}));
</script>

<template>
    <!-- The work waiting to land, its land under way, or its land refused: one line of the dock, as the board card says it. -->
    <ChatDockRow v-if="strip.kind === `ready`" icon="git-branch" tone="done" :title="words.readyToLand" role="status" data-land-strip>
        <template v-if="diff !== undefined" #meta>
            <span>{{ t(`chat.chatLandStrip.files`, { count: diff.files }, diff.files) }}</span>
            <span class="text-success">+{{ diff.insertions }}</span>
            <span class="text-danger">−{{ diff.deletions }}</span>
        </template>
        <template v-if="explanation !== undefined" #detail>
            <p class="leading-relaxed">{{ explanation }}</p>
        </template>
        <template #actions>
            <Button size="small" thumb tier="boring" class="whitespace-nowrap" @click="openReview">{{ words.review }}</Button>
            <AgentLandPress
                :can-ship="canShip"
                :agent="agent"
                :land-disabled="landDisabled"
                :requesting="requesting"
                :land-hint="landHint"
                :request-hint="requestHint"
                :explain="false"
                :lit="lit"
                @land="land"
                @request="requestLand"
            />
        </template>
        <!-- Under work that waits for a press: the one time letting the sandbox take such presses over is worth asking. -->
        <HandsOffOffer />
    </ChatDockRow>
    <ChatDockRow v-else-if="strip.kind === `landing`" icon="spinner" spin tone="busy" :title="words.landing" role="status" data-land-strip />
    <ChatDockRow v-else icon="exclamation-triangle" tone="warning" :title="conflict.chip" role="status" data-land-strip>
        <!-- The one way on from a refused land: its review, where the conflict is read and fixed. -->
        <template #actions>
            <Button size="small" thumb :tier="lit ? `accent` : `boring`" class="whitespace-nowrap" @click="openReview">{{ conflict.verb }}</Button>
        </template>
    </ChatDockRow>
</template>
