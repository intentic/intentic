<script setup lang="ts">
import type { RepoCheckMoment, RepoChecksSummary } from "@intentic/sandbox-contract/schemas/settings";
import { Row, timeAgo } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import RuleCommand from "./RuleCommand.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* ONE REPOSITORY'S OWN CHECKS, as a row. */

const {
    entry,
    title,
    busy = false,
    disabled = false,
} = defineProps<{
    entry: RepoChecksSummary;
    // Names the switch instead of the repository, for a surface that already names the repository and its file.
    title?: string;
    // This row's own write is in flight; the switch goes quiet rather than the whole page.
    busy?: boolean;
    disabled?: boolean;
}>();

const emit = defineEmits<{ switch: [boolean] }>();

// "root" is the workspace's own repository, which nobody calls "root" when they mean it.
const name = computed((): string => (entry.repo === `root` ? t(`sandbox.repoCheckRow.thisWorkspace`) : entry.repo));

const MOMENTS: readonly RepoCheckMoment[] = [`edit`, `turn`, `land`];

// A `turn` check runs once as an isolated turn ends, and what it finds is said back to the agent, so its label says it
// never blocks. `land` is retired: nothing runs after work lands any more (CI checks what is pushed), and a declaration
// naming it still reads but runs nothing, so its label says so rather than promising a check that never comes.
const momentWords = (when: RepoCheckMoment): string =>
    when === `edit`
        ? t(`sandbox.repoCheckRow.afterEachEdit`)
        : when === `turn`
          ? t(`sandbox.repoCheckRow.whenTurnEnds`)
          : t(`sandbox.repoCheckRow.landRetired`);

// When a check last flagged something; one that never has is either healthy or aimed at nothing, and worth a look.
const firedWords = (at: number | null | undefined): string =>
    at === null || at === undefined
        ? t(`sandbox.repoCheckRow.neverFlagged`)
        : t(`sandbox.repoCheckRow.lastFlagged`, { ago: timeAgo(at, { days: true }) });

// Whether a check runs: all of them once the owner agreed to the file as it stands, and in a file changed since, each one
// still word for word what they agreed to. A sandbox that does not say which (no `held`) holds a changed file whole.
const runs = (index: number): boolean =>
    entry.checks[index]?.when !== `land` && (entry.adopted || (entry.changed && entry.held !== undefined && entry.held[index] === false));

// New or rewritten since the owner agreed: what switching the row on again would accept.
const waits = (index: number): boolean => entry.changed && entry.checks[index]?.when !== `land` && (entry.held?.[index] ?? true);

type Line = { key: string; run: string; paths: string; note: string | undefined; waiting: boolean; dim: boolean };
type Group = { when: RepoCheckMoment; lines: Line[]; dim: boolean };

// One moment's checks under a single label, in the order the moments come; a label dims only when nothing under it runs.
const groups = computed((): Group[] =>
    MOMENTS.map((when): Group => {
        const lines = entry.checks.flatMap((check, index): Line[] =>
            check.when !== when
                ? []
                : [
                      {
                          key: `${index}`,
                          run: check.run,
                          // Repo-relative, as the file spells them; the daemon is the one that prefixes the repository.
                          paths: (check.paths ?? []).join(`, `),
                          // A running check stamps a firing when it reports something; one that waits says so instead,
                          // and a retired one has nothing left to have flagged.
                          note: runs(index) ? firedWords(entry.fired[index]) : waits(index) ? t(`sandbox.repoCheckRow.waitsForYou`) : undefined,
                          waiting: waits(index),
                          // Only a check's own line dims when it does not run, never the switch that would start it; a
                          // retired check reads as inert as one nobody switched on.
                          dim: !runs(index),
                      },
                  ],
        );
        return { when, lines, dim: lines.every((line) => line.dim) };
    }).filter((group) => group.lines.length > 0),
);

// How many of a changed file's checks wait, when some of the rest still run; zero when the whole file is paused.
const waitingWhileRunning = computed((): number => {
    const indices = entry.checks.map((_, index) => index);
    return indices.some(runs) ? indices.filter(waits).length : 0;
});

type Status = { tone: `success` | `warning` | `default`; words: string | undefined } | undefined;

// What the switch means right now; a repository declaring nothing has nothing to switch. The healthy state has no words:
// the switch standing on and the shield turning green already say it runs, so a line only appears when something is off.
const status = computed((): Status => {
    if (entry.checks.length === 0) {
        return undefined;
    }
    if (entry.changed) {
        const waiting = waitingWhileRunning.value;
        return {
            tone: `warning`,
            words:
                waiting > 0 ? t(`sandbox.repoCheckRow.partlyPaused`, { count: waiting }, waiting) : t(`sandbox.repoCheckRow.changedSinceSwitchedOn`),
        };
    }
    return entry.adopted
        ? { tone: `success`, words: undefined }
        : { tone: `default`, words: t(`sandbox.repoCheckRow.declaredNotRunningNothing`) };
});

const STATUS_TEXT = { success: `text-success`, warning: `text-warning`, default: `text-subtle` } as const;

const statusWords = computed((): string | undefined => status.value?.words);
</script>

<template>
    <Row indent icon="shield" :tone="status?.tone ?? `default`">
        <template #title>
            <span class="flex min-w-0 items-baseline gap-x-2">
                <span class="min-w-0 truncate">{{ title ?? name }}</span>
                <span v-if="title === undefined" class="min-w-0 truncate font-mono text-2xs text-subtle" v-tooltip.top.overflow="entry.path">{{
                    entry.path
                }}</span>
            </span>
        </template>
        <template v-if="entry.error !== undefined || statusWords !== undefined" #description>
            <span v-if="entry.error !== undefined" class="text-danger">{{
                t(`sandbox.repoCheckRow.checksFileCouldNot`, { error: entry.error })
            }}</span>
            <span v-else-if="status !== undefined" :class="STATUS_TEXT[status.tone]">{{ statusWords }}</span>
        </template>
        <!-- Only a declaration has anything to adopt. -->
        <template v-if="entry.checks.length > 0" #control>
            <ToggleSwitch
                :model-value="entry.adopted"
                :disabled="disabled || busy"
                :aria-label="t(`sandbox.repoCheckRow.runChecksDeclares`, { name })"
                @update:model-value="(value: boolean) => emit(`switch`, value)"
            />
        </template>
        <!-- No surface of its own: `indent` starts the list under the title, which is what says it belongs to this row, as
             every other row's sub-block in the sandbox settings does. Type, not boxes, tells the moment, the command and
             its scope and verdict apart. -->
        <template v-if="entry.error === undefined && groups.length > 0" #below>
            <div class="flex min-w-0 flex-col gap-3 text-xs">
                <div v-for="group in groups" :key="group.when" class="flex min-w-0 flex-col gap-1.5">
                    <p class="text-2xs text-subtle" :class="group.dim ? `opacity-60` : ``">{{ momentWords(group.when) }}</p>
                    <ul class="flex min-w-0 flex-col gap-2">
                        <li v-for="line in group.lines" :key="line.key" class="flex min-w-0 flex-col gap-0.5" :class="line.dim ? `opacity-60` : ``">
                            <!-- The command wraps so the approval target remains fully readable. -->
                            <RuleCommand :command="line.run" wrap />
                            <!-- Its scope and its verdict share one quiet line, so neither needs a column a narrow pane cannot give. -->
                            <span
                                v-if="line.paths !== `` || line.note !== undefined"
                                class="flex min-w-0 flex-wrap gap-x-1.5 text-2xs text-subtle"
                            >
                                <span v-if="line.paths !== ``" class="min-w-0 break-words"
                                    >{{ t(`sandbox.words.onlyTouching`) }} <span class="font-mono text-muted">{{ line.paths }}</span></span
                                >
                                <span v-if="line.paths !== `` && line.note !== undefined" aria-hidden="true">·</span>
                                <span v-if="line.note !== undefined" class="tabular-nums" :class="line.waiting ? `text-warning` : ``">{{
                                    line.note
                                }}</span>
                            </span>
                        </li>
                    </ul>
                </div>
            </div>
        </template>
    </Row>
</template>
