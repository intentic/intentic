<script setup lang="ts">
import type { IndexRun, IndexRunDir } from "@intentic/sandbox-contract/schemas/git/index-run";
import { Button, ConfirmDialog, formatBytes, formatCount, Icon } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { cancelIndexRun, followedRuns, holdQuestions } from "../../../../models/changes/indexRuns";

// The two things a stage or commit run (models/changes/indexRuns.ts) asks of the reader, drawn under the commit box of
// whichever Changes panel is open: the guardrail's question before a stage that would take thousands of files, naming
// the folders that make it big, and while a run goes, where it is and a Stop that kills git.

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

const running = computed(() => [...followedRuns.value.entries()].filter(([, followed]) => followed.run.status === `running`));
const phaseLine = (repo: string, run: IndexRun): string => {
    const total = run.files?.total;
    switch (run.phase) {
        case `waiting`:
            return t(`workspace.indexRunPrompt.waiting`, { repo });
        case `counting`:
            return t(`workspace.indexRunPrompt.counting`, { repo });
        case `staging`:
            return total === undefined
                ? t(`workspace.indexRunPrompt.staging`, { repo })
                : t(`workspace.indexRunPrompt.stagingFiles`, { repo, count: formatCount(total) }, total);
        default:
            return t(`workspace.indexRunPrompt.committing`, { repo });
    }
};
</script>

<template>
    <div v-if="running.length > 0" class="flex flex-col gap-1">
        <!-- One line per repo with a run going, its Stop beside it; a lost poll says so instead of freezing the phase. -->
        <div v-for="[repo, followed] in running" :key="repo" class="flex min-w-0 items-center gap-2 text-2xs text-muted">
            <Icon name="spinner" spin class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ phaseLine(repo, followed.run) }}</span>
            <span v-if="followed.lostContact" class="shrink-0 text-warning">{{ t(`workspace.indexRunPrompt.reconnecting`) }}</span>
            <Button size="small" class="shrink-0" @click="cancelIndexRun(repo)">{{ t(`workspace.indexRunPrompt.stop`) }}</Button>
        </div>
    </div>
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
