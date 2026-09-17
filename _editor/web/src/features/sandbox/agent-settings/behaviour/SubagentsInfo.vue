<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The (i) beside the Agent tab's "Subagents" group. */

const WHICH_CAP = [
    [`Subagents at once`, `A single fan-out stops part-way and the rest run after`, `A wide sweep: many files, many checks, all at the same time`],
    [`Subagents per conversation`, `A long conversation stops delegating entirely`, `Hours in one chat, or a workflow that keeps spawning rounds`],
    [`Nesting depth`, `An agent's own agent is refused`, `Work that splits, then splits again: a lead agent running its own team`],
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.subagentsInfo.subagents`)">
        <p class="text-sm text-muted">
            {{ t(`sandbox.subagentsInfo.assistantHandPieceWork`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.subagentsInfo.oneYouveHit`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.subagentsInfo.theyStopDifferentThings`) }}
        </p>
        <InfoTable class="mt-2" :headers="[``, `What you see`, `When it bites`]" :rows="WHICH_CAP" />

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.subagentsInfo.whatHappensAtLimit`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.subagentsInfo.nothingFailsAssistantTold`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.subagentsInfo.whatRaisingCosts`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.subagentsInfo.everyAgentModelRunning`) }}
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.subagentsInfo.leftAloneAllThree`) }}
            <span class="font-medium text-content">{{ t(`sandbox.subagentsInfo.usage`) }}</span
            >{{ t(`sandbox.subagentsInfo.whatRunningRightNow`) }}
            <span class="font-medium text-content">{{ t(`sandbox.subagentsInfo.subagents`) }}</span> {{ t(`sandbox.subagentsInfo.inSidebar`) }}
        </p>
    </InfoDialog>
</template>
