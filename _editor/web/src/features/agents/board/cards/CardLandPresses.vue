<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import { reviewedAll } from "../../../../models/fleet/board/reviewMarks";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import TourMark from "../../../tour/TourMark.vue";
import { useCardRequests } from "./cardRequests";

// A Ready card's presses (AgentCard draws this only while it is Ready or its land runs): a maintainer's Land now, a
// collaborator's Request land, and the standing ask either one is about.
//
// LAND LEADS; READING IS OFFERED, NEVER REQUIRED. Reviewing a diff before it lands is often skipped on purpose (a small
// change, work the agent already checked, a fresh session's review), so Land now is always the card's first press. A
// card whose changes the reader has not ticked through (reviewedAll) offers the review beside it, quieter, and drops it
// once every file is read. A card with no counted diff has nothing to offer reading.

const t = useT();

const props = defineProps<{
    agent: FleetAgent;
    title: string;
    // Another action of the card's holds every press.
    busy: boolean;
    // This card's land is in flight, from this window or another.
    landing: boolean;
}>();
const emit = defineEmits<{ land: []; changes: [] }>();

// Maintainers get Land now; collaborators get Request land instead, since the daemon floors landing at maintainer.
const { canReview, canShip } = useRole();
const words = useVocabulary();
// Request land goes to the daemon from here (cardRequests.ts), since the board is only one of the card's hosts.
const { requesting, requestLand, landAsk } = useCardRequests(() => props.agent, () => props.title);
const landable = computed(() => props.agent.status === `ready`);
const files = computed(() => props.agent.diff?.files ?? 0);
const unread = computed(() => landable.value && !props.landing && files.value > 0 && !reviewedAll(props.agent.id, files.value));
</script>

<template>
    <!-- Success-styled with the check glyph, matching the review panel's own Land now: the same action on the same work must read as such. -->
    <div v-if="canShip" class="flex min-w-0 flex-col gap-1">
        <!-- The standing ask leads the button it's about, so a maintainer meets the reason before the press. -->
        <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-warning">
            <Icon name="clock" class="shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }}</span>
        </p>
        <!-- Disabled while the land runs: the daemon refuses a second one outright (agents.routes CONFLICT). -->
        <div class="flex flex-wrap items-center gap-1.5">
            <Button size="small" tone="success" thumb :disabled="landing || busy" class="self-start whitespace-nowrap" @click.stop="emit('land')">
                <Icon :name="landing ? 'spinner' : 'check'" :spin="landing" />{{ landing ? words.landing : words.land }}
            </Button>
            <!-- Unread work offers its review after the land, never before it (see `unread`). -->
            <Button v-if="unread" size="small" tier="quiet" thumb class="self-start whitespace-nowrap" :disabled="busy" @click.stop="emit('changes')">
                <Icon name="eye" />{{ t(`agents.agentStatus.reviewChanges`) }}
            </Button>
            <!-- Getting started's mark for the first land, beside the press that does it (only while that is the step). -->
            <TourMark v-if="!landing" step="land" place="card" :priority="3" side="bottom" @click.stop />
        </div>
    </div>

    <!-- The same Ready card for a collaborator: land is a maintainer's press, so this offers the ask instead, same spot and size but quieter chrome. -->
    <div v-else-if="landable && canReview" class="flex min-w-0 flex-col gap-1">
        <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-muted">
            <Icon name="clock" class="shrink-0 text-2xs" /><span class="min-w-0">{{
                t(`agents.agentCard.waitingMaintainer`, { landAsk })
            }}</span>
        </p>
        <template v-else>
            <Button size="small" tier="boring" :disabled="busy" class="self-start whitespace-nowrap" @click.stop="requestLand">
                <Icon :name="requesting ? 'spinner' : 'send'" :spin="requesting" />{{
                    requesting ? t(`agents.agentCard.asking`) : words.requestLand
                }}
            </Button>
            <span class="text-2xs leading-snug text-subtle">{{ words.requestLandHint }}.</span>
        </template>
    </div>
</template>
