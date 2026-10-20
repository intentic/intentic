<script setup lang="ts">
import type { IndexRunDir } from "@intentic/sandbox-contract/schemas/git/index-run";
import { ConfirmDialog, formatBytes, formatCount, Icon } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { holdQuestions } from "../../../../models/changes/indexRuns";

// The guardrail's question before a stage or commit run (models/changes/indexRuns.ts) that would take thousands of
// files, naming the folders that make it big, asked from whichever Changes panel is open. Where a run is while it goes
// is the bar's own line (runLine.ts, drawn by IndexRunLine.vue), never a second one here.

const question = computed(() => holdQuestions.value[0]);
const files = computed(() => question.value?.hold.files ?? 0);
const header = computed(() =>
    question.value?.op === `commit`
        ? t(`workspace.indexRunPrompt.commitFiles`, { count: formatCount(files.value) }, files.value)
        : t(`workspace.indexRunPrompt.stageFiles`, { count: formatCount(files.value) }, files.value),
);
const dirLabel = (dir: IndexRunDir): string => {
    const where = dir.dir === `` ? t(`workspace.indexRunPrompt.repoRoot`) : `${dir.dir}/`;
    const count = t(`workspace.indexRunPrompt.dirFiles`, { count: formatCount(dir.files) }, dir.files);
    return dir.bytes === undefined ? `${where} · ${count}` : `${where} · ${count} · ${formatBytes(dir.bytes)}`;
};
</script>

<template>
    <!-- Not destructive: going ahead stages, which unstaging takes back; the warning is about what it would sweep in. -->
    <ConfirmDialog
        :open="question !== undefined"
        :header="header"
        :description="t(`workspace.indexRunPrompt.looksLikeDependencies`)"
        :confirm-label="question?.op === `commit` ? t(`workspace.indexRunPrompt.commitAnyway`) : t(`workspace.indexRunPrompt.stageAnyway`)"
        :destructive="false"
        tone="warning"
        :items="question?.hold.dirs ?? []"
        @cancel="question?.answer(false)"
        @confirm="question?.answer(true)"
    >
        <template #item="{ item }">
            <Icon name="folder" class="shrink-0 text-muted" />
            <span class="truncate text-content">{{ dirLabel(item) }}</span>
        </template>
    </ConfirmDialog>
</template>
