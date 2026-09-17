<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The (i) beside the Agent tab's "Skills" group. */

const ORIGINS = [
    [`Yours`, `You wrote it here`, `Edit, switch off, or delete it`],
    [`Built in`, `Ships with this sandbox`, `Switch it off`],
    [`Connection`, `Came with a tool, machine or account you connected`, `Goes when you disconnect that`],
    [`Extension`, `Ships inside an installed extension`, `Switch the extension off`],
    [`Plugin`, `Ships inside a plugin you installed`, `Remove the plugin`],
    [`Loose file`, `Sitting in the skills folder: by hand, or written by the agent`, `Delete it`],
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.skillsInfo.skills`)">
        <p class="text-sm text-muted">
            {{ t(`sandbox.skillsInfo.skillNoteAssistantReads`) }}
        </p>
        <p class="mt-2 text-sm text-muted">
            {{ t(`sandbox.skillsInfo.everythingAgentCarryingRight`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.skillsInfo.whereTheyCome`) }}</h3>
        <InfoTable class="mt-2" :headers="[`Kind`, `Where it came from`, `What you can do`]" :rows="ORIGINS" />

        <!-- The one thing about this list that surprises people, and the reason the switches are worth using. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.skillsInfo.moreIsntBetter`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.skillsInfo.assistantReadsEverySkills`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.skillsInfo.writingGoodOne`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.skillsInfo.toUseLineDoes`) }}
        </p>
        <p class="mt-1.5 text-2xs text-subtle">{{ t(`sandbox.skillsInfo.changesLandOnNext`) }}</p>
    </InfoDialog>
</template>
