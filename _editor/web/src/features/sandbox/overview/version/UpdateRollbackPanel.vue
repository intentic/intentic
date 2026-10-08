<!-- The way back, once someone asked for it: what it returns to, whom it interrupts, and the one control that takes it.
     Opened from the update card's quiet "Having trouble?" or from a withdrawn release's notice; never drawn unasked. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import HostRecreate from "../../../capabilities/connect/hosts/HostRecreate.vue";

const t = useT();

defineProps<{
    /** The sentence it opens with when the owner came looking; a withdrawn release has already said why. */
    lead?: string;
    /** Agents mid-turn right now, whose work going back interrupts. */
    midTurn: number;
    /** The tail of the image digest it returns to; the platform keeps its own on a hosted sandbox, so unnamed there. */
    digest?: string;
    hosted: boolean;
    slug?: string;
}>();

// The platform asks its own question for a hosted sandbox (HostedRollbackDialog), which the card owns.
const emit = defineEmits<{ hostedRollback: [] }>();
</script>

<template>
    <div class="flex flex-col gap-2 rounded-lg bg-card shadow-sm p-3">
        <p v-if="lead" class="text-xs text-muted">{{ lead }}</p>
        <p v-if="midTurn > 0" class="text-2xs text-warning">
            {{ t(`sandbox.sandboxUpdateCard.midTurnRollback`, { count: midTurn }, midTurn) }}
        </p>
        <p class="text-2xs text-subtle">
            <template v-if="digest && !hosted">{{ t(`sandbox.sandboxUpdateCard.rollsBackTo`) }} <span class="font-mono">…{{ digest }}</span>. </template>
            {{ t(`sandbox.sandboxUpdateCard.filesStay`) }}
        </p>
        <!-- Own block so the column's stretch doesn't draw a small button at full width. -->
        <div v-if="hosted">
            <Button :label="t(`sandbox.sandboxUpdateCard.rollBackToPrevious`)" size="small" tier="boring" @click="emit(`hostedRollback`)" />
        </div>
        <HostRecreate v-else-if="slug" :slug="slug" action="Roll back" />
    </div>
</template>
