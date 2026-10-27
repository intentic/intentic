<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import TourMark from "../../../tour/TourMark.vue";
import { useCardRequests } from "./cardRequests";

// A Ready card's presses (AgentCard draws this only while it is Ready or its land runs): a maintainer's Land now, a
// collaborator's Request land, and the standing ask either one is about.
//
// The change count on the card opens its diff; this block only offers the land.

const t = useT();

const props = defineProps<{
    agent: FleetAgent;
    title: string;
    // Another action of the card's holds every press.
    busy: boolean;
    // This card's land is in flight, from this window or another.
    landing: boolean;
}>();
const emit = defineEmits<{ land: [] }>();

// Maintainers get Land now; collaborators get Request land instead, since the daemon floors landing at maintainer.
const { canReview, canShip } = useRole();
const words = useVocabulary();
// Request land goes to the daemon from here (cardRequests.ts), since the board is only one of the card's hosts.
const { requesting, requestLand, landAsk } = useCardRequests(() => props.agent, () => props.title);
const landable = computed(() => props.agent.status === `ready`);
</script>

<template>
    <!-- Success-styled with the check glyph, matching the review panel's own Land now: the same action on the same work must read as such. -->
    <div v-if="canShip" data-shares class="flex min-w-0 flex-col gap-1">
        <!-- The standing ask leads the button it's about, so a maintainer meets the reason before the press. -->
        <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-warning">
            <Icon name="clock" class="shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }}</span>
        </p>
        <!-- Disabled while the land runs: the daemon refuses a second one outright (agents.routes CONFLICT). -->
        <div class="flex flex-wrap items-center gap-1.5">
            <Button tier="accent" size="small" tone="success" thumb :disabled="landing || busy" class="self-start whitespace-nowrap" @click.stop="emit('land')">
                <Icon :name="landing ? 'spinner' : 'check'" :spin="landing" />{{ landing ? words.landing : words.land }}
            </Button>
            <!-- Getting started's mark for the first land, beside the press that does it (only while that is the step). -->
            <TourMark v-if="!landing" step="land" place="card" :priority="3" side="bottom" @click.stop />
        </div>
    </div>

    <!-- The same Ready card for a collaborator: land is a maintainer's press, so this offers the ask instead, same spot and size but quieter chrome. -->
    <div v-else-if="landable && canReview" data-shares class="flex min-w-0 flex-col gap-1">
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
