<script setup lang="ts">
import type { RepoCheckMoment, RepoChecksSummary } from "@intentic/sandbox-contract/schemas/settings";
import { Row, type Tip, timeAgo } from "@intentic/ui";
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

// A moment is named in a word or two in its own column; what it means past that (a `turn` check is said back to the agent
// once and never blocks; `land` is retired, since CI checks what is pushed) rides a hover card rather than a sentence.
const momentLabel = (when: RepoCheckMoment): string =>
    when === `edit`
        ? t(`sandbox.repoCheckRow.momentEdit`)
        : when === `turn`
          ? t(`sandbox.repoCheckRow.momentTurn`)
          : t(`sandbox.repoCheckRow.momentLand`);

const momentTip = (when: RepoCheckMoment): Tip | undefined =>
    when === `edit`
        ? undefined
        : {
              title: momentLabel(when),
              note: when === `turn` ? t(`sandbox.repoCheckRow.momentTurnNote`) : t(`sandbox.repoCheckRow.momentLandNote`),
          };

// When a check last flagged something, as a bare age in the trailing column (its hover names it); one that never has is
// either healthy or aimed at nothing, and reads as a dash.
const firedNote = (at: number | null | undefined): Note =>
    at === null || at === undefined
        ? { words: `—`, tip: t(`sandbox.repoCheckRow.neverFlagged`), waiting: false }
        : { words: timeAgo(at, { days: true }), tip: t(`sandbox.repoCheckRow.lastFlagged`), waiting: false };

// Whether a check runs: all of them once the owner agreed to the file as it stands, and in a file changed since, each one
// still word for word what they agreed to. A sandbox that does not say which (no `held`) holds a changed file whole.
const runs = (index: number): boolean =>
    entry.checks[index]?.when !== `land` && (entry.adopted || (entry.changed && entry.held !== undefined && entry.held[index] === false));

// New or rewritten since the owner agreed: what switching the row on again would accept.
const waits = (index: number): boolean => entry.changed && entry.checks[index]?.when !== `land` && (entry.held?.[index] ?? true);

type Note = { words: string; tip: string | undefined; waiting: boolean };
type Line = { key: string; run: string; paths: string; note: Note | undefined; dim: boolean };
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
                          note: runs(index)
                              ? firedNote(entry.fired[index])
                              : waits(index)
                                ? { words: t(`sandbox.repoCheckRow.waitsForYou`), tip: undefined, waiting: true }
                                : undefined,
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
             every other row's sub-block in the sandbox settings does. One line per check: the moment in a narrow leading
             column (named once per moment), the command, and its verdict at the trailing edge. -->
        <template v-if="entry.error === undefined && groups.length > 0" #below>
            <div class="flex min-w-0 flex-col gap-1.5 text-xs">
                <div v-for="group in groups" :key="group.when" class="flex min-w-0 items-baseline gap-3">
                    <p
                        class="w-16 shrink-0 text-2xs text-subtle"
                        :class="[group.dim ? `opacity-60` : ``, momentTip(group.when) === undefined ? `` : `cursor-help`]"
                        v-tooltip.top="momentTip(group.when)"
                    >
                        {{ momentLabel(group.when) }}
                    </p>
                    <ul class="flex min-w-0 flex-1 flex-col gap-1">
                        <li
                            v-for="line in group.lines"
                            :key="line.key"
                            class="flex min-w-0 items-baseline justify-between gap-3"
                            :class="line.dim ? `opacity-60` : ``"
                        >
                            <!-- The command wraps so the approval target remains fully readable; its scope follows it. -->
                            <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                                <RuleCommand :command="line.run" wrap />
                                <!-- Only when the change touches these; the hover says so, the globs alone read as a scope. -->
                                <span
                                    v-if="line.paths !== ``"
                                    class="min-w-0 cursor-help break-words font-mono text-2xs text-subtle"
                                    v-tooltip.top="{ title: t(`sandbox.repoCheckRow.scopeTip`), note: line.paths }"
                                    >{{ line.paths }}</span
                                >
                            </span>
                            <span
                                v-if="line.note !== undefined"
                                class="shrink-0 whitespace-nowrap text-2xs tabular-nums"
                                :class="line.note.waiting ? `text-warning` : `text-subtle`"
                                v-tooltip.top="line.note.tip"
                                >{{ line.note.words }}</span
                            >
                        </li>
                    </ul>
                </div>
            </div>
        </template>
    </Row>
</template>
