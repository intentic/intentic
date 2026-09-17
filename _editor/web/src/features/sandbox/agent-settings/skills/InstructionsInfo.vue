<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { promptReach, spokenList } from "./promptReach";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const PROMPT_MODES = [
    [`Intentic`, `Our prompt, tuned for this app. The default.`, `Improves with the app`],
    [`Claude`, `Claude Code's own, read from your sandbox's CLI.`, `Improves with the sandbox`],
    [`Custom`, `Yours, replacing both, and everything below.`, `Frozen the day you write it`],
];

const PROMPT_LOST = [
    [`The built-in prompt`, `Its whole approach to reading, editing and verifying code`],
    [`The question and plan cards`, `It writes "A) … B) …" as text instead of a card you can click`],
    [`The checklist panel`, `Long tasks run with no visible plan to follow along with`],
    [`The browser tools`, `It stops knowing a real browser is available and reaches for curl`],
    [`Knowing how to wait`, `It polls a build with sleep instead of backgrounding it and being woken`],
];

const PROMPT_KEPT = [
    [`Every tool`, `Nothing is removed, only what the model has been TOLD changes`],
    [`Memory and your skills`, `Your standing instructions ride your own prompt; skills load from the workspace as before`],
    [`The in-turn notices`, `Hooks are a separate layer: the search, dependency and diagnostics steers still fire`],
    [`Cross-provider delegation`, `Moves into the first message instead of the prompt`],
];

const reach = promptReach();
const REACH_ROWS = [
    [spokenList(reach.replaces), `Your prompt replaces theirs`],
    ...(reach.adds.length > 0 ? [[spokenList(reach.adds), `Keeps its own prompt; yours is added to it`]] : []),
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.instructionsInfo.instructions`)">
        <p class="text-sm text-muted">{{ t(`sandbox.instructionsInfo.whatAssistantToldBefore`) }}</p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.instructionsInfo.systemPrompt`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.instructionsInfo.instructionsAssistantCarriesBefore`) }}
            <span class="font-medium text-content">{{ t(`sandbox.instructionsInfo.viewPrompt`) }}</span> {{ t(`sandbox.instructionsInfo.onSetting`) }}
        </p>
        <InfoTable class="mt-2" :headers="[`Option`, `What it is`, `Over time`]" :rows="PROMPT_MODES" />
        <p class="mt-2 text-2xs text-muted">
            {{ t(`sandbox.instructionsInfo.intenticClaudePeersDifferent`) }}
            <span class="font-medium text-content">{{ t(`sandbox.instructionsInfo.replaces`) }}</span>
            {{ t(`sandbox.instructionsInfo.notAddsToReplaces`) }}
        </p>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-warning/40">
                <p class="border-b border-warning/40 bg-warning/10 px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-warning">
                    {{ t(`sandbox.instructionsInfo.whatCustomGivesUp`) }}
                </p>
                <div class="flex flex-col gap-1.5 px-2.5 py-2">
                    <p v-for="[what, effect] in PROMPT_LOST" :key="what" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ what }}</span
                        >: {{ effect }}
                    </p>
                </div>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.instructionsInfo.whatStays`) }}
                </p>
                <div class="flex flex-col gap-1.5 px-2.5 py-2">
                    <p v-for="[what, effect] in PROMPT_KEPT" :key="what" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ what }}</span
                        >: {{ effect }}
                    </p>
                </div>
            </div>
        </div>
        <p class="mt-2 text-2xs text-subtle">
            <span class="font-medium text-content">{{ t(`sandbox.instructionsInfo.editCopy`) }}</span>
            {{ t(`sandbox.instructionsInfo.gentlerRouteIntoCustom`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.instructionsInfo.whereApplies`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.instructionsInfo.everyChatInSandbox`) }}
        </p>
        <InfoTable class="mt-2" :headers="[`Model`, `What happens`]" :rows="REACH_ROWS" />
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.instructionsInfo.agentInstallYourselfBrings`) }}
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.instructionsInfo.editingCostsOneTurns`) }}
        </p>
    </InfoDialog>
</template>
