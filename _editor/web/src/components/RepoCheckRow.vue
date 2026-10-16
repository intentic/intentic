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

type Line = { key: string; when: RepoCheckMoment; run: string; paths: readonly string[]; note: string | undefined; waiting: boolean; dim: boolean };

// In the order of their moments, so one moment's checks sit together under a single label.
const lines = computed((): Line[] =>
    entry.checks
        .map((check, index): Line => ({
            key: `${index}`,
            when: check.when,
            run: check.run,
            paths: check.paths ?? [],
            // A running check stamps a firing when it reports something; one that waits says so instead, and a retired
            // one has nothing left to have flagged.
            note: runs(index) ? firedWords(entry.fired[index]) : waits(index) ? t(`sandbox.repoCheckRow.waitsForYou`) : undefined,
            waiting: waits(index),
            // Only a check's own line dims when it does not run, never the switch that would start it; a retired check
            // reads as inert as one nobody switched on.
            dim: !runs(index),
        }))
        .toSorted((a, b) => MOMENTS.indexOf(a.when) - MOMENTS.indexOf(b.when)),
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
    <Row icon="shield" :tone="status?.tone ?? `default`" class="@container/repo-check">
        <template #title>
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span>{{ title ?? name }}</span>
                <span v-if="title === undefined" class="min-w-0 break-all font-mono text-2xs text-subtle">{{ entry.path }}</span>
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
        <template v-if="entry.error === undefined && lines.length > 0" #below>
            <!-- Commands get their own full-width line in a narrow row. Wider rows align moments, commands and verdicts in three columns. -->
            <ul
                class="grid grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-line-subtle bg-canvas/60 text-xs @xl/repo-check:grid-cols-[max-content_minmax(0,1fr)_max-content]"
            >
                <li
                    v-for="(line, index) in lines"
                    :key="line.key"
                    class="col-span-full grid grid-cols-subgrid items-baseline gap-x-3 gap-y-1 px-3 py-2 @xl/repo-check:gap-x-4"
                    :class="[index > 0 && line.when !== lines[index - 1]!.when ? `border-t border-line-subtle` : ``, line.dim ? `opacity-60` : ``]"
                >
                    <span class="col-start-1 row-start-1 min-w-0 break-words text-2xs text-subtle">{{
                        index > 0 && line.when === lines[index - 1]!.when ? `` : momentWords(line.when)
                    }}</span>
                    <span
                        class="col-span-full row-start-2 flex min-w-0 flex-col gap-1 @xl/repo-check:col-span-1 @xl/repo-check:col-start-2 @xl/repo-check:row-start-1"
                    >
                        <!-- The command wraps so the approval target remains fully readable. -->
                        <RuleCommand :command="line.run" wrap />
                        <!-- Repo-relative, as the file spells them; the daemon is the one that prefixes the repository. -->
                        <span v-if="line.paths.length > 0" class="flex min-w-0 flex-wrap items-center gap-1.5 text-2xs text-subtle">
                            {{ t(`sandbox.words.onlyTouching`) }}
                            <span
                                v-for="glob in line.paths"
                                :key="glob"
                                class="max-w-48 truncate rounded border border-line-subtle bg-overlay px-1.5 font-mono text-content"
                                v-tooltip.top.overflow="glob"
                                >{{ glob }}</span
                            >
                        </span>
                    </span>
                    <span
                        class="col-start-2 row-start-1 min-w-0 break-words text-right text-2xs tabular-nums @xl/repo-check:col-start-3"
                        :class="line.waiting ? `text-warning` : `text-subtle`"
                        >{{ line.note ?? `` }}</span
                    >
                </li>
            </ul>
        </template>
    </Row>
</template>
