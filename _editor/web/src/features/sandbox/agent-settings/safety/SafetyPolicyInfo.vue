<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The (i) beside the Safety policy. */

const TIERS = [
    [
        `The sandbox itself`,
        `A container, a git worktree of its own, credentials masked out of everything the model reads`,
        `Nobody. Nothing here can change it.`,
    ],
    [`A quick pattern match`, `Spots the handful of commands worth a second look, and is wrong often`, `Nobody`],
    [
        `A model reading your policy`,
        `Applies what you wrote to this command, plus what the sandbox knows about the turn`,
        `Nobody, unless it decides to ask`,
    ],
    [`You`, `A card, with the model's one-sentence reason on it`, `You`],
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.safetyPolicyInfo.safetyPolicy`)">
        <p class="text-sm text-muted">
            {{ t(`sandbox.safetyPolicyInfo.assistantRunsCommandsOn`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.safetyPolicyInfo.whatHappensToCommand`) }}</h3>
        <InfoTable class="mt-2" :headers="[`Step`, `What it does`, `Who it interrupts`]" :rows="TIERS" />

        <!-- The honest limit, and the reason the page is safe to hand to the assistant. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.safetyPolicyInfo.whatCannotDo`) }}</h3>
        <p class="mt-2 text-2xs text-muted">
            {{ t(`sandbox.safetyPolicyInfo.decides`) }}
            <span class="font-medium text-content">{{ t(`sandbox.safetyPolicyInfo.howOftenInterrupted`) }}</span
            >{{ t(`sandbox.safetyPolicyInfo.notWhatAssistantCapable`) }}
        </p>
        <p class="mt-2 text-2xs text-muted">
            {{ t(`sandbox.safetyPolicyInfo.alsoWhyAssistantMay`) }}
        </p>
        <p class="mt-2 text-2xs text-muted">
            {{ t(`sandbox.safetyPolicyInfo.fewRulesSitOutside`) }} <code>/</code>{{ t(`sandbox.safetyPolicyInfo.deletingAnythingUnder`) }}
            <code>/history</code>. On your own computers, any delete as well, because nothing there is rebuilt from an image. A model can be argued
            into most things by text inside the command it is judging, and those cost more than any policy line is worth. They are also the rules the
            <span class="font-medium text-content">{{ t(`sandbox.safetyPolicyInfo.safetyJudge`) }}</span>
            {{ t(`sandbox.safetyPolicyInfo.switchAboveCannotReach`) }}
            <span class="font-medium text-content">{{ t(`sandbox.safetyPolicyInfo.whatGetsStopped`) }}</span>
            {{ t(`sandbox.safetyPolicyInfo.listsAll`) }}
        </p>
    </InfoDialog>
</template>
