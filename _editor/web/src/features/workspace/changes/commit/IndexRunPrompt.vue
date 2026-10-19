<script setup lang="ts">
import type { IndexRun, IndexRunDir } from "@intentic/sandbox-contract/schemas/git/index-run";
import { Button, ConfirmDialog, formatBytes, formatCount, Icon } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { cancelIndexRun, followedRuns, holdQuestions } from "../../../../models/changes/indexRuns";

const emit = defineEmits<{ progress: [repos: readonly string[]] }>();

// The two things a stage or commit run (models/changes/indexRuns.ts) asks of the reader, drawn in the press bar under
// the commit box of whichever Changes panel is open: the guardrail's question before a stage that would take thousands
// of files, naming the folders that make it big, and while a slow run goes, where it is and a Stop that kills git.
//
// The run's line takes the bar's own reading line, beside the presses, rather than a row of its own under the box: a
// row per repo pushed the box, the bar and the whole list down for the second a slow commit took and back up when it
// ended. One line for every repo (the oldest run's phase, the rest counted, each on the hover) and one Stop for all.

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

// A run's row waits this long before it is drawn. Most commits answer well inside it, and a row per repo appearing and
// going again in under a second pushed the whole panel down and back up for nothing: the press's own spinner and the
// bar's line already say a commit is under way. Past it, the phase and the Stop are worth the room they take. Every
// repo's row comes in together, once the oldest run is slow, so a commit across repos moves the panel once, not per repo.
const SLOW_RUN_MS = 1_000;
const following = computed(() => [...followedRuns.value.entries()].filter(([, followed]) => followed.run.status === `running`));
const now = useNow(() => following.value.length > 0, 250);
const running = computed(() => (following.value.some(([, followed]) => now.value - followed.since >= SLOW_RUN_MS) ? following.value : []));
watch(running, (runs) => emit(`progress`, runs.map(([repo]) => repo)), { immediate: true });
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
const lead = computed(() => running.value[0]);
const others = computed(() => running.value.length - 1);
const lostContact = computed(() => running.value.some(([, followed]) => followed.lostContact));
// Each repo's own phase, for the hover, once the line is speaking for more than one.
const tip = computed(() => (others.value > 0 ? running.value.map(([repo, followed]) => phaseLine(repo, followed.run)).join(`\n`) : undefined));
const stopAll = (): void => {
    for (const [repo] of running.value) {
        void cancelIndexRun(repo);
    }
};
</script>

<template>
    <!-- A flex item of the bar it sits in: grows into the reading line's room, and is never taller than a press. -->
    <span v-if="lead" class="flex min-w-0 flex-1 basis-28 items-center gap-1.5 text-2xs text-muted" aria-live="polite">
        <Icon name="spinner" spin class="shrink-0" />
        <span class="min-w-0 truncate whitespace-nowrap" v-tooltip.right="tip">{{ phaseLine(lead[0], lead[1].run) }}</span>
        <span v-if="others > 0" class="shrink-0 tabular-nums text-subtle">{{ t(`workspace.indexRunPrompt.andMore`, { count: others }) }}</span>
        <span v-if="lostContact" class="shrink-0 text-warning">{{ t(`workspace.indexRunPrompt.reconnecting`) }}</span>
        <Button size="small" class="ml-auto shrink-0" @click="stopAll">{{ t(`workspace.indexRunPrompt.stop`) }}</Button>
    </span>
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
