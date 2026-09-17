<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The (i) beside the Agent tab's "Code search" group. */

const IQ_COMPARISON = [
    [`A typical hunt`, `Several calls, then whole files read to find one function`, `One call`],
    [`What comes back`, `Every line that matched the text`, `Ranked answers, trimmed to a token budget`],
    [`Each result`, `A file to open and scan`, `A path:line anchor it can open directly`],
    [`When your words aren't the code's words`, `Misses`, `Still finds it`],
];

const MAP_COMPARISON = [
    [`How a conversation starts`, `Listing folders to see what's here`, `The list is already in front of it`],
    [`Where it looks first`, `The top, then downwards`, `The project it was opened in`],
    [`When you rename a folder`, `Old notes keep naming the old one`, `Read again next conversation`],
];

const SHADOW_COMPARISON = [
    [`Reading a Word file or PDF`, `Parsed mid-task, every time it's needed`, `The text version already exists`],
    [`A scanned PDF or a photo`, `An empty or failed read`, `A note saying exactly what's missing and why`],
    [`When a document changes`, `Stale knowledge until someone re-reads it`, `Re-rendered in the background as it lands`],
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.codeSearchInfo.codeSearch`)">
        <p class="text-sm text-muted">{{ t(`sandbox.codeSearchInfo.howAssistantFindsWay`) }}</p>

        <!-- ① iq: an off/on comparison, because the value is entirely relative to grep. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.codeSearchInfo.iqCodeSearch`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.codeSearchInfo.iqSearchToolBuilt`) }}
        </p>
        <InfoTable class="mt-2" :headers="[``, `Off: grep / find / glob`, `On: iq`]" :rows="IQ_COMPARISON" />
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.codeSearchInfo.switchingOnLoadsSmall`) }}
        </p>
        <!-- Why this setting carries a measurement control, and the one rule that makes its arms honest. -->
        <div class="mt-2 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">{{ t(`sandbox.codeSearchInfo.measure`) }}</span>
                {{ t(`sandbox.codeSearchInfo.runsSliceConversationsWithout`) }}
            </p>
        </div>

        <!-- ② Project map, one question earlier than ①. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.codeSearchInfo.projectMap`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.codeSearchInfo.beforeSearchAnythingAssistant`) }}
        </p>
        <InfoTable class="mt-2" :headers="[``, `Off: it looks around first`, `On: handed the layout`]" :rows="MAP_COMPARISON" />
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.codeSearchInfo.eachPartsDescriptionTaken`) }}
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.codeSearchInfo.followsConversationOpenOne`) }}
        </p>
        <div class="mt-2 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="refresh" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">{{ t(`sandbox.codeSearchInfo.readFreshNeverStored`) }}</span>
                {{ t(`sandbox.codeSearchInfo.differenceBetweenWritingSame`) }}
            </p>
        </div>
        <!-- The map measurement uses a different score from its neighbour. -->
        <div class="mt-2 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">{{ t(`sandbox.codeSearchInfo.measure`) }}</span>
                {{ t(`sandbox.codeSearchInfo.opensSliceConversationsWithout`) }}
                <span class="text-content">{{ t(`sandbox.codeSearchInfo.firstMessage`) }}</span> {{ t(`sandbox.codeSearchInfo.onlyMessageMapEver`) }}
            </p>
        </div>

        <!-- ③ Document shadows, one step before either of the above: the files no text search can see into. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.codeSearchInfo.documentShadows`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.codeSearchInfo.someFilesInWorkspace`) }}
        </p>
        <InfoTable class="mt-2" :headers="[``, `Off: parsed on demand`, `On: shadowed as files land`]" :rows="SHADOW_COMPARISON" />
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.codeSearchInfo.nothingInventedWhatRendering`) }}
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.codeSearchInfo.offAssistantStillRead`) }}
        </p>
    </InfoDialog>
</template>
