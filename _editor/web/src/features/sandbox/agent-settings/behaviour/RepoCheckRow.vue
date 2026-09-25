<script setup lang="ts">
import type { RepoCheckMoment, RepoChecksSummary } from "@intentic/sandbox-contract";
import { Row, timeAgo } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import RuleCommand from "../safety/RuleCommand.vue";
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
const name = computed((): string => (entry.repo === `root` ? `This workspace` : entry.repo));

const MOMENTS: readonly RepoCheckMoment[] = [`edit`, `turn`, `land`];

// `turn` is retired: nothing runs when a turn ends any more, and a declaration naming it still reads but runs nothing, so
// its label says so rather than promising a check that never comes.
const momentWords = (when: RepoCheckMoment): string =>
    when === `edit`
        ? t(`sandbox.repoCheckRow.afterEachEdit`)
        : when === `turn`
          ? t(`sandbox.repoCheckRow.turnRetired`)
          : t(`sandbox.repoCheckRow.afterItLands`);

// When a check last flagged something; one that never has is either healthy or aimed at nothing, and worth a look.
const firedWords = (at: number | null | undefined): string =>
    at === null || at === undefined ? t(`sandbox.repoCheckRow.neverFlagged`) : t(`sandbox.repoCheckRow.lastFlagged`, { ago: timeAgo(at, { days: true }) });

// Declared checks that are not running; only their own lines dim, never the switch that would start them.
const idle = computed(() => !entry.adopted && !entry.changed);

type Line = { key: string; when: RepoCheckMoment; run: string; paths: readonly string[]; note: string | undefined; dim: boolean };

// In the order they run, so one moment's checks sit together under a single label; a declared `land` check replaces
// the package script that otherwise runs after a land.
const lines = computed((): Line[] => {
    const declared = entry.checks.map(
        (check, index): Line => ({
            key: `${index}`,
            when: check.when,
            run: check.run,
            paths: check.paths ?? [],
            // A land's verdict is the main line's (the chat rail and the board); only an edit check stamps a firing, and
            // a retired turn check has nothing left to have flagged.
            note: check.when === `edit` && entry.adopted ? firedWords(entry.fired[index]) : undefined,
            // A retired check reads as inert as one nobody switched on: neither runs.
            dim: idle.value || check.when === `turn`,
        }),
    );
    const fallback: Line[] =
        entry.landDefault === undefined || entry.checks.some((check) => check.when === `land`)
            ? []
            : [{ key: `package`, when: `land`, run: entry.landDefault, paths: [], note: t(`sandbox.repoCheckRow.packageScript`), dim: false }];
    return [...declared, ...fallback].toSorted((a, b) => MOMENTS.indexOf(a.when) - MOMENTS.indexOf(b.when));
});

type Status = { tone: `success` | `warning` | `default`; words: string } | undefined;

// What the switch means right now, said beside it; a repository declaring nothing has nothing to switch.
const status = computed((): Status => {
    if (entry.checks.length === 0) {
        return undefined;
    }
    if (entry.changed) {
        return { tone: `warning`, words: t(`sandbox.repoCheckRow.changedSinceSwitchedOn`) };
    }
    return entry.adopted
        ? { tone: `success`, words: t(`sandbox.repoCheckRow.running`) }
        : { tone: `default`, words: t(`sandbox.repoCheckRow.declaredNotRunningNothing`) };
});

const STATUS_TEXT = { success: `text-success`, warning: `text-warning`, default: `text-subtle` } as const;
</script>

<template>
    <Row icon="shield" :tone="status?.tone ?? `default`">
        <template #title>
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span>{{ title ?? name }}</span>
                <span v-if="title === undefined" class="min-w-0 break-all font-mono text-2xs text-subtle">{{ entry.path }}</span>
            </span>
        </template>
        <template v-if="entry.error !== undefined || status !== undefined" #description>
            <span v-if="entry.error !== undefined" class="text-danger">{{ t(`sandbox.repoCheckRow.checksFileCouldNot`, { error: entry.error }) }}</span>
            <span v-else-if="status !== undefined" class="inline-flex items-baseline gap-1.5" :class="STATUS_TEXT[status.tone]">
                <span v-if="status.tone === `success`" class="size-1.5 shrink-0 translate-y-[-0.1em] rounded-full bg-success" aria-hidden="true" />
                {{ status.words }}
            </span>
        </template>
        <!-- Only a declaration has anything to adopt; the package script runs regardless. -->
        <template v-if="entry.checks.length > 0" #control>
            <ToggleSwitch
                :model-value="entry.adopted"
                :disabled="disabled || busy"
                :aria-label="t(`sandbox.repoCheckRow.runChecksDeclares`, { name })"
                @update:model-value="(value: boolean) => emit(`switch`, value)"
            />
        </template>
        <template v-if="entry.error === undefined && lines.length > 0" #below>
            <!-- Three columns shared by every line, so moments, commands and verdicts each read down one edge. -->
            <ul class="grid grid-cols-[max-content_minmax(0,1fr)_max-content] overflow-hidden rounded-lg border border-line-subtle bg-canvas/60 text-xs">
                <li
                    v-for="(line, index) in lines"
                    :key="line.key"
                    class="col-span-3 grid grid-cols-subgrid items-baseline gap-x-4 px-3 py-2"
                    :class="[index > 0 && line.when !== lines[index - 1]!.when ? `border-t border-line-subtle` : ``, line.dim ? `opacity-60` : ``]"
                >
                    <span class="text-2xs text-subtle">{{ index > 0 && line.when === lines[index - 1]!.when ? `` : momentWords(line.when) }}</span>
                    <span class="flex min-w-0 flex-col gap-1">
                        <!-- The command wraps so the approval target remains fully readable. -->
                        <RuleCommand :command="line.run" wrap />
                        <!-- Repo-relative, as the file spells them; the daemon is the one that prefixes the repository. -->
                        <span v-if="line.paths.length > 0" class="flex min-w-0 flex-wrap items-center gap-1.5 text-2xs text-subtle">
                            {{ t(`shared.onlyTouching`) }}
                            <span
                                v-for="glob in line.paths"
                                :key="glob"
                                class="max-w-48 truncate rounded border border-line-subtle bg-overlay px-1.5 font-mono text-content"
                                :title="glob"
                                >{{ glob }}</span
                            >
                        </span>
                    </span>
                    <span class="text-right text-2xs tabular-nums text-subtle">{{ line.note ?? `` }}</span>
                </li>
            </ul>
        </template>
    </Row>
</template>
