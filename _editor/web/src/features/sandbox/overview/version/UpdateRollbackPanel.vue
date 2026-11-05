<!-- The way back, once someone asked for it: one row naming the step, its button, and what it costs as a line of facts
     the reader takes in at a glance. The sentences behind each fact are its tooltip, and the confirmation names the
     agents it interrupts, so nothing here is a paragraph. Opened from the update card's quiet "Having trouble?" or from
     a withdrawn release's notice; never drawn unasked. -->
<script setup lang="ts">
import { Button, type IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import HostRecreate from "../../../capabilities/connect/hosts/HostRecreate.vue";

const t = useT();

const props = defineProps<{
    /** How long the previous version stays ready on this machine, as a sentence, when the last update said so. */
    ready?: string;
    /** Agents mid-turn right now, whose work going back interrupts. */
    midTurn: number;
    hosted: boolean;
    slug?: string;
}>();

// The platform asks its own question for a hosted sandbox (HostedRollbackDialog), which the card owns.
const emit = defineEmits<{ hostedRollback: [] }>();

interface Fact {
    readonly icon: IconName;
    readonly label: string;
    readonly tip: string;
    readonly warn?: boolean;
}
const facts = computed((): Fact[] => [
    { icon: `clock`, label: t(`sandbox.sandboxUpdateCard.factDowntime`), tip: props.ready ?? t(`capabilities.hostRecreate.costRollBack`) },
    { icon: `shield`, label: t(`sandbox.sandboxUpdateCard.factFilesStay`), tip: t(`sandbox.sandboxUpdateCard.filesStay`) },
    ...(props.midTurn > 0
        ? [
              {
                  icon: `exclamation-triangle` as const,
                  label: t(`sandbox.sandboxUpdateCard.factAgentsWorking`, { count: props.midTurn }, props.midTurn),
                  tip: t(`sandbox.sandboxUpdateCard.midTurnRollback`, { count: props.midTurn }, props.midTurn),
                  warn: true,
              },
          ]
        : []),
]);
</script>

<template>
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div class="flex min-w-0 flex-col gap-1.5">
            <p class="text-sm font-medium text-content">{{ t(`sandbox.sandboxUpdateCard.rollBackToPrevious`) }}</p>
            <ul class="flex flex-wrap gap-x-4 gap-y-1">
                <li
                    v-for="fact in facts"
                    :key="fact.icon"
                    v-tooltip.top="fact.tip"
                    class="flex items-center gap-1.5 text-2xs"
                    :class="fact.warn ? `text-warning` : `text-muted`"
                >
                    <Icon :name="fact.icon" class="shrink-0" :class="!fact.warn && `text-subtle`" aria-hidden="true" />{{ fact.label }}
                    <!-- The sentence behind the fact, for a reader who never hovers. -->
                    <span class="sr-only">{{ fact.tip }}</span>
                </li>
            </ul>
        </div>
        <!-- Own block so a wrapping row doesn't stretch a small button to full width. -->
        <div v-if="hosted">
            <Button :label="t(`capabilities.hostRecreate.rollBackVerb`)" size="small" tier="accent" @click="emit(`hostedRollback`)">
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </div>
        <HostRecreate v-else-if="slug" :slug="slug" action="Roll back" bare />
    </div>
</template>
