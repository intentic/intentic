<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The (i) beside the Agent tab's "Finished work" group: what happens to an agent's work once it stops, and to the agent itself. */

const AT_A_GLANCE = [
    [`Land finished work automatically`, `Whether clean work reaches your workspace by itself`, `Off`],
    [`Save a version of accepted work`, `Whether landed work is committed for you, and your own edits before the next agent starts`, `Off`],
    [`Archive finished agents`, `How long finished work stays on the board`, `3 days`],
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.finishedWorkInfo.finishedWork`)">
        <p class="text-sm text-muted">{{ t(`sandbox.finishedWorkInfo.whatHappensAfterAgent`) }}</p>
        <InfoTable class="mt-2" :headers="[`Setting`, `What it changes`, `Default`]" :rows="AT_A_GLANCE" />

        <!-- ① Landing: the difference is who moves the work, and the honest framing is that OFF is a queue you have to visit. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">
            {{ t(`sandbox.finishedWorkInfo.landFinishedWorkAutomatically`) }}
        </h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.finishedWorkInfo.agentWorksOnOwn`) }}
        </p>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.finishedWorkInfo.on`) }}
                </p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    {{ t(`sandbox.finishedWorkInfo.cleanFinishAppliesStraight`) }}
                </p>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.finishedWorkInfo.offDefault`) }}
                </p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    {{ t(`sandbox.finishedWorkInfo.everyCleanFinishBecomes`) }}
                    <span class="font-medium text-content">{{ t(`sandbox.finishedWorkInfo.readyToLand`) }}</span>
                    {{ t(`sandbox.finishedWorkInfo.cardNothingTouchesWorkspace`) }}
                </p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.finishedWorkInfo.sandboxWideDefaultRather`) }}
        </p>

        <!-- ② Archiving: a lifecycle, so a lifecycle strip, then the kept/released split it turns on. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.finishedWorkInfo.archiveFinishedAgents`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.finishedWorkInfo.everyAgentWorksIn`) }}
        </p>
        <div class="mt-2 flex items-stretch gap-1.5">
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="check-circle" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">{{ t(`sandbox.finishedWorkInfo.agentFinishes`) }}</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="clock" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">{{ t(`sandbox.finishedWorkInfo.quietChosenTime`) }}</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="box" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">{{ t(`sandbox.finishedWorkInfo.archived`) }}</span>
            </div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2">
            <div class="rounded-lg border border-line bg-canvas p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-content">
                    <Icon name="eraser" class="text-subtle" /> {{ t(`sandbox.finishedWorkInfo.released`) }}
                </p>
                <p class="mt-1 text-2xs text-muted">{{ t(`sandbox.finishedWorkInfo.checkoutRepoSpotOn`) }}</p>
            </div>
            <div class="rounded-lg border border-line bg-canvas p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-content">
                    <Icon name="history" class="text-subtle" /> {{ t(`sandbox.finishedWorkInfo.kept`) }}
                </p>
                <p class="mt-1 text-2xs text-muted">{{ t(`sandbox.finishedWorkInfo.branchDiffWholeConversation`) }}</p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.finishedWorkInfo.talkingToAgentResets`) }}
        </p>
    </InfoDialog>
</template>
