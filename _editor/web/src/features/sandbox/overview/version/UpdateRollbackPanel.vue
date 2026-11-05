<!-- The way back, once someone asked for it: its name and its one control, nothing else in words. What it costs is a
     single mark beside the name (a quiet ⓘ, amber when agents are mid-turn) whose hover card holds the figures; the
     confirmation names the agents it interrupts. Opened from the update card's quiet "Having trouble?" or from a
     withdrawn release's notice; never drawn unasked. -->
<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import HostRecreate from "../../../capabilities/connect/hosts/HostRecreate.vue";

const t = useT();

const props = defineProps<{
    /** Until when the previous version stays parked on this machine ("14:05 tomorrow"), when the last update said. */
    readyUntil?: string;
    /** Agents mid-turn right now, whose work going back interrupts. */
    midTurn: number;
    hosted: boolean;
    slug?: string;
}>();

// The platform asks its own question for a hosted sandbox (HostedRollbackDialog), which the card owns.
const emit = defineEmits<{ hostedRollback: [] }>();

const tip = computed(
    (): Tip => ({
        title: t(`capabilities.hostRecreate.rollBackVerb`),
        rows: [
            { label: t(`sandbox.sandboxUpdateCard.tipDowntime`), value: t(`sandbox.sandboxUpdateCard.tipDowntimeValue`) },
            { label: t(`sandbox.sandboxUpdateCard.tipFiles`), value: t(`sandbox.sandboxUpdateCard.tipKept`) },
            ...(props.readyUntil === undefined ? [] : [{ label: t(`sandbox.sandboxUpdateCard.tipReadyUntil`), value: props.readyUntil }]),
            ...(props.midTurn > 0 ? [{ label: t(`sandbox.sandboxUpdateCard.tipAgentsWorking`), value: props.midTurn, tone: `warning` as const }] : []),
        ],
    }),
);
// The sentence the card's figures stand for, for a reader who never hovers.
const spoken = computed(() =>
    [t(`capabilities.hostRecreate.costRollBack`), t(`sandbox.sandboxUpdateCard.filesStay`)]
        .concat(props.readyUntil === undefined ? [] : [`${t(`sandbox.sandboxUpdateCard.tipReadyUntil`)} ${props.readyUntil}.`])
        .concat(props.midTurn > 0 ? [t(`sandbox.sandboxUpdateCard.midTurnRollback`, { count: props.midTurn }, props.midTurn)] : [])
        .join(` `),
);
</script>

<template>
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p class="flex min-w-0 items-center gap-2 text-sm font-medium text-content">
            {{ t(`sandbox.sandboxUpdateCard.rollBackToPrevious`) }}
            <span v-tooltip.top="tip" tabindex="0" class="inline-flex shrink-0" :class="midTurn > 0 ? `text-warning` : `text-subtle`">
                <Icon :name="midTurn > 0 ? `exclamation-triangle` : `info-circle`" aria-hidden="true" />
                <span class="sr-only">{{ spoken }}</span>
            </span>
        </p>
        <!-- Own block so a wrapping row doesn't stretch a small button to full width. -->
        <div v-if="hosted">
            <Button :label="t(`capabilities.hostRecreate.rollBackVerb`)" size="small" tier="accent" @click="emit(`hostedRollback`)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </div>
        <!-- On a machine this page cannot reach, the command alone takes the row under the name. -->
        <HostRecreate v-else-if="slug" class="max-w-full" :slug="slug" action="Roll back" bare terse />
    </div>
</template>
