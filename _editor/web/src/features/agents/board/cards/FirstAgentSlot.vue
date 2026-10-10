<!-- The first agent's place on a first run's board: the spot in Active its card will arrive in, holding the ways to start it.
     Dashed like every place something will go, so the board reads as the board from the first visit and the first card
     takes this slot's place rather than redrawing the screen around it. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { composeAgent, startAgent } from "../../fleet/agentActions";
import type { Starter } from "../view/firstScreen";
import TourMark from "../../../tour/TourMark.vue";

const t = useT();

const { starters } = defineProps<{ starters: readonly Starter[] }>();
</script>

<template>
    <div class="relative flex flex-col gap-2 rounded-xl border border-dashed border-primary-500/50 bg-primary-600/5 p-3.5" data-reveal>
        <!-- The getting-started mark for the first agent: this slot is where that step is done, so it outranks the
             composer's and the rail's marks for the same step whenever the board is on screen. -->
        <TourMark step="agent" place="board" :priority="3" side="bottom" class="absolute -right-1 -top-1" />
        <p class="text-xs font-semibold text-content">{{ t(`agents.firstAgentSlot.title`) }}</p>
        <p class="text-2xs leading-snug text-muted">{{ t(`agents.firstAgentSlot.line`) }}</p>
        <!-- Starters fill the composer and never send: the reader sends their own first turn. -->
        <div class="flex flex-wrap gap-1.5">
            <button v-for="starter in starters" :key="starter.label" type="button" class="ui-chip" @click="composeAgent(starter.prompt)">
                {{ starter.label }}
            </button>
            <button type="button" class="ui-chip gap-1" @click="startAgent()">
                <Icon name="pencil" class="text-2xs" />{{ t(`agents.firstAgentSlot.writeYourOwn`) }}
            </button>
        </div>
    </div>
</template>
