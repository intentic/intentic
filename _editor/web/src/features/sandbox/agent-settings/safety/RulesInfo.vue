<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The (i) beside the Agent tab's "Rules" group. */

const MOMENTS = [
    [`After it edits a file`, `Run a command on that file; what it prints on failure goes back with the edit`, `Once per edited file`],
    [`Before the assistant finishes`, `Send it back to work, or run something it has to pass`, `Once per turn`],
    [`Before you push`, `Run a command; the push waits on it`, `Once per push`],
    [`When an agent finishes`, `Land its work, or hold it on its branch`, `Once per finished agent`],
    [
        `After its work is accepted`,
        `Save a version: commit what it changed, and your own edits before the next agent starts`,
        `Once per accepted change`,
    ],
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.rulesInfo.rules`)">
        <p class="text-sm text-muted">
            {{ t(`sandbox.rulesInfo.ruleSentenceAtMoment`) }}
        </p>
        <InfoTable class="mt-2" :headers="[`Moment`, `What a rule can do there`, `How often it runs`]" :rows="MOMENTS" />

        <!-- The one genuinely surprising thing: two moments here treat a list of rules differently. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.rulesInfo.severalRulesMatch`) }}</h3>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.rulesInfo.momentsDoThings`) }}
                </p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    {{ t(`sandbox.rulesInfo.beforeTurnEndsBefore`) }} <span class="font-medium text-content">{{ t(`sandbox.rulesInfo.every`) }}</span>
                    {{ t(`sandbox.rulesInfo.matchingRuleRunsIn`) }}
                </p>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.rulesInfo.momentsDecide`) }}
                </p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    {{ t(`sandbox.rulesInfo.agentFinishesOneQuestion`) }}
                    <span class="font-medium text-content">{{ t(`sandbox.rulesInfo.first`) }}</span>
                    {{ t(`sandbox.rulesInfo.matchingRuleAnswersRest`) }}
                </p>
            </div>
        </div>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.rulesInfo.narrowingByPath`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.rulesInfo.pathsWrittenWayYoud`) }} <span class="font-mono">docs/**</span>, <span class="font-mono">**/*.sql</span>,
            <span class="font-mono">api/src/**</span>{{ t(`sandbox.rulesInfo.readWorkspaceRootSame`) }}
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.rulesInfo.nothingHereRuleApplies`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.rulesInfo.ruleDoesSomething`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.rulesInfo.anythingBlocksPushHolds`) }}
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.rulesInfo.eachRuleAlsoShows`) }}
        </p>
    </InfoDialog>
</template>
