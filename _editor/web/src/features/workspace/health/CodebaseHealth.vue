<script setup lang="ts">
import { Card, EmptyState, formatCount, Meter, Notice, Picker, SegmentedControl, SkeletonSnapshot, ui, useAgentRunPick, vSkeletonSource } from "@intentic/ui";
import { computed, ref } from "vue";
import { shellModelPicking } from "../../chat/models/shellModelPicking";
import RefactorAction from "./RefactorAction.vue";
import { useCodebaseHealth } from "./useCodebaseHealth";
import { useRepos } from "../explorer/useRepos";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { type ChurnWindow, churnWindows, hotspotRows, moduleRows, perFile } from "./codebaseHealth";
import { useT } from "@intentic/ui/i18n";

// A repository's Health tab in the management panel, and the workspace root's own health tab; answers where the risk
// sits, via hotspots (churn x complexity) and map (PageRank over imports). Every number is a count a reader can
// recount, never a grade, so a row opens a file, not a score. Each row names the refactor its own numbers call for,
// and pressing that name hands the file to an agent, on the Refactors job's model unless the row's caret picks another
// for that one run.

const t = useT();

const { repo } = defineProps<{ repo: string }>();
// Opens through the tab store rather than an emit: the management panel mounts this view through ExtensionView, which
// binds props and listens to nothing.
const { openFile, openHealth } = useWorkspaceTabs();

const repoRef = computed(() => repo);
const churnWindow = ref<ChurnWindow>(`all`);
const { health, loading, error, refresh } = useCodebaseHealth(repoRef, churnWindow);
const { options } = useRepos();
// One picker for every row: a caret's pick starts its run at once and clears (RefactorAction), so no row inherits it.
const refactorPick = useAgentRunPick(shellModelPicking, `refactor-run`);

const totals = computed(() => health.value?.totals);
// Dormancy is measured from the read, not a live clock; recomputes only when the report or window changes.
const rows = computed(() => hotspotRows(health.value?.hotspots ?? [], health.value?.modules ?? [], churnWindow.value, Date.now()));
const modules = computed(() => moduleRows(health.value?.modules ?? []));
// Index builds in the background; a fresh panel may read a partial one, so this says so instead of showing 0.
const building = computed(() => health.value?.freshness.state === `building`);

// The orientation strip: scale first, then the one count the list below details.
const stats = computed(() => {
    const figures = totals.value;
    if (figures === undefined) {
        return [];
    }
    return [
        { key: `files`, label: t(`shared.files`), value: figures.files, note: t(`workspace.codebaseHealth.indexedIgnoringBuildOutput`) },
        { key: `symbols`, label: t(`workspace.codebaseHealth.symbols`), value: figures.symbols, note: t(`workspace.codebaseHealth.functionsTypesClasses`) },
        {
            key: `complexity`,
            label: t(`workspace.codebaseHealth.branchPoints`),
            value: figures.complexity,
            note: t(`workspace.codebaseHealth.perFile`, { files: perFile(figures.complexity, figures.files) }),
        },
        { key: `hotspots`, label: t(`workspace.codebaseHealth.hotspots`), value: figures.hotspots, note: t(`workspace.codebaseHealth.filesBothChurnBranching`) },
    ];
});

// Rows show the deepest folder first when the path is cut, so the trailing separator would only cost a character.
const folder = (dir: string): string => (dir.endsWith(`/`) ? dir.slice(0, -1) : dir);

// One column set for both lists' rows and their header, through subgrid, so every figure lines up under its heading.
const HOTSPOT_COLUMNS = `grid grid-cols-[1.25rem_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-2 @sm:gap-x-3`;
const MODULE_COLUMNS = `grid grid-cols-[1.25rem_minmax(0,1fr)_auto_auto] items-center gap-x-2 @sm:gap-x-3`;
</script>

<template>
    <div class="flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Header: repo switcher, churn window, refresh; the same bar the Git tab beside it wears. -->
        <div class="@container flex h-8 shrink-0 items-center gap-1.5 border-b border-line-subtle bg-card pr-1.5 pl-3">
            <Icon name="wave-pulse" class="shrink-0 text-xs text-subtle" />
            <Picker
                v-if="options.length > 1"
                :model-value="repo"
                :options="options.map((option) => ({ value: option, label: option }))"
                variant="ghost"
                class="max-w-48"
                :aria-label="t(`workspace.codebaseHealth.repository`)"
                @update:model-value="(value: string | undefined) => value !== undefined && openHealth(value)"
            />
            <span v-else class="truncate text-xs font-medium text-content">{{ repo }}</span>
            <span class="flex-1"></span>
            <!-- The window narrows churn only; complexity reflects the file as it stands today and doesn't move with it. -->
            <span class="hidden shrink-0 text-2xs text-subtle @sm:inline">{{ t(`workspace.codebaseHealth.commits`) }}</span>
            <SegmentedControl v-model="churnWindow" size="xs" :options="churnWindows()" />
            <!-- The refresh glyph turns while a read is out, so the bar never grows a second spinner beside it. -->
            <button
                type="button"
                :class="ui.iconButton()"
                v-tooltip.bottom="t(`workspace.codebaseHealth.recompute`)"
                :aria-label="t(`workspace.codebaseHealth.refreshCodebaseHealth`)"
                @click="refresh()"
            >
                <Icon name="refresh" class="text-2xs" :spin="loading" />
            </button>
        </div>

        <Notice v-if="error" strip size="sm" :of="{ tone: `danger`, title: t(`workspace.codebaseHealth.couldntRead`), detail: error }" />
        <Notice v-if="building" strip size="sm" tone="warning">{{ t(`workspace.codebaseHealth.indexStillBuildingFigures`) }}</Notice>

        <div class="min-h-0 flex-1 overflow-auto">
            <div class="@container mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
                <!-- First read: the report as it last looked in this sandbox, else a drawn outline of one. -->
                <SkeletonSnapshot v-if="totals === undefined && loading" :of="`health:${repo}`" :label="t(`workspace.codebaseHealth.readingIndex`)">
                    <div role="status" aria-busy="true" class="flex flex-col gap-4">
                        <span class="sr-only">{{ t(`workspace.codebaseHealth.readingIndex`) }}</span>
                        <Card class="grid grid-cols-2 gap-4 @2xl:grid-cols-4" aria-hidden="true">
                            <div v-for="tile in 4" :key="tile" class="flex flex-col gap-2">
                                <span class="skeleton block h-2.5 w-14" />
                                <span class="skeleton block h-5 w-16" />
                                <span class="skeleton block h-2 w-24" />
                            </div>
                        </Card>
                        <Card class="flex flex-col gap-3" aria-hidden="true">
                            <span class="skeleton block h-3.5 w-24" />
                            <div v-for="line in 6" :key="line" class="flex items-center gap-3">
                                <span class="skeleton block h-3 w-40" />
                                <span class="flex-1" />
                                <span class="skeleton block h-1 w-24" />
                                <span class="skeleton block h-3 w-12" />
                            </div>
                        </Card>
                    </div>
                </SkeletonSnapshot>

                <EmptyState v-else-if="totals === undefined" icon="wave-pulse" :title="t(`workspace.codebaseHealth.noReportYet`)" class="py-12" />

                <div v-else v-skeleton-source="`health:${repo}`" class="flex flex-col gap-4">
                    <!-- Unrelated counts share no axis, so they sit as a strip of figures rather than a chart. -->
                    <Card class="p-0">
                        <dl class="grid grid-cols-2 @2xl:grid-cols-4">
                            <div
                                v-for="(stat, index) in stats"
                                :key="stat.key"
                                class="flex min-w-0 flex-col gap-1 border-line-subtle px-4 py-3"
                                :class="[index % 2 === 1 ? `border-l` : ``, index >= 2 ? `border-t @2xl:border-t-0` : ``, index === 2 ? `@2xl:border-l` : ``]"
                            >
                                <dt class="truncate text-2xs text-muted">{{ stat.label }}</dt>
                                <dd class="truncate text-xl leading-none font-semibold text-content">{{ formatCount(stat.value) }}</dd>
                                <dd class="text-2xs leading-snug text-subtle">{{ stat.note }}</dd>
                            </div>
                        </dl>
                    </Card>

                    <Card class="@container flex flex-col gap-3 p-4 @2xl:p-5">
                        <header class="flex flex-col gap-1">
                            <div class="flex items-baseline justify-between gap-3">
                                <h3 class="text-sm font-semibold text-content">{{ t(`workspace.codebaseHealth.hotspots`) }}</h3>
                                <span v-if="totals.hotspots > rows.length" class="shrink-0 text-2xs text-subtle tabular-nums">{{
                                    t(`workspace.codebaseHealth.shownOf`, { count: rows.length, hotspots: formatCount(totals.hotspots) })
                                }}</span>
                            </div>
                            <p class="text-xs leading-relaxed text-muted">{{ t(`workspace.codebaseHealth.hotspotsLead`) }}</p>
                        </header>

                        <p v-if="rows.length === 0" class="py-2 text-xs text-subtle">{{ t(`workspace.codebaseHealth.noFileHereBoth`) }}</p>
                        <div v-else :class="HOTSPOT_COLUMNS">
                            <div class="col-span-6 grid grid-cols-subgrid items-end border-b border-line-subtle pb-1.5 text-2xs text-subtle">
                                <span class="text-right">#</span>
                                <span>{{ t(`workspace.codebaseHealth.file`) }}</span>
                                <span v-tooltip.top="{ title: t(`workspace.codebaseHealth.risk`), note: t(`workspace.codebaseHealth.riskNote`) }" class="cursor-help">{{
                                    t(`workspace.codebaseHealth.risk`)
                                }}</span>
                                <span class="text-right">{{ t(`workspace.codebaseHealth.commits2`) }}</span>
                                <!-- Wraps onto two lines in a narrow pane, so the heading never claims more width than its figures. -->
                                <span class="w-min justify-self-end text-right @sm:w-auto">{{ t(`workspace.codebaseHealth.branchPoints`) }}</span>
                                <span class="hidden @2xl:inline">{{ t(`workspace.codebaseHealth.suggested`) }}</span>
                            </div>
                            <ul class="col-span-6 grid grid-cols-subgrid">
                                <li
                                    v-for="(row, index) in rows"
                                    :key="row.path"
                                    class="col-span-6 grid min-h-9 grid-cols-subgrid items-center border-b border-line-subtle last:border-b-0"
                                >
                                    <!-- The row opens the file; a quiet season dims it, since a file nobody edits costs nobody anything. -->
                                    <button
                                        type="button"
                                        class="group/row col-span-5 -mx-1.5 grid cursor-pointer grid-cols-subgrid items-center rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-overlay"
                                        @click="openFile(row.path)"
                                    >
                                        <span class="text-right text-2xs text-subtle tabular-nums">{{ index + 1 }}</span>
                                        <span class="flex min-w-0 flex-col @2xl:flex-row @2xl:items-baseline @2xl:gap-2">
                                            <span
                                                class="max-w-full truncate text-xs @2xl:shrink-0"
                                                :class="row.ask.dormant ? `text-muted` : `text-content`"
                                                v-tooltip.top.overflow="row.name"
                                                >{{ row.name }}</span
                                            >
                                            <!-- Under the name, or beside it on a wide pane; cut from the left, so the folder nearest the file survives. -->
                                            <span
                                                v-if="row.dir"
                                                class="min-w-0 truncate text-left text-2xs text-subtle [direction:rtl]"
                                                v-tooltip.top.overflow="row.dir"
                                                ><bdi>{{ folder(row.dir) }}</bdi></span
                                            >
                                        </span>
                                        <!-- One hue for every bar; length already encodes magnitude, so colour must not. -->
                                        <Meter :value="row.share" :tone="row.ask.dormant ? `muted` : `accent`" grow :grow-step="index" class="w-8 @sm:w-14 @lg:w-20 @2xl:w-28" />
                                        <span class="text-right text-xs text-muted tabular-nums">{{ formatCount(row.commits) }}</span>
                                        <span class="text-right text-xs text-muted tabular-nums">{{ formatCount(row.complexity) }}</span>
                                    </button>
                                    <!-- The refactor this row's own figures call for: a word, not a bare glyph, so a press is never a surprise. -->
                                    <RefactorAction
                                        :prompt="row.ask.prompt"
                                        :name="row.name"
                                        :hint="row.ask.hint"
                                        :dormant="row.ask.dormant"
                                        :picker="refactorPick"
                                    />
                                </li>
                            </ul>
                        </div>
                        <!-- Where the action column is too narrow to name its refactor, a legend says what the glyph does. -->
                        <p v-if="rows.length > 0" class="flex items-center gap-1.5 text-2xs text-subtle @2xl:hidden">
                            <Icon name="sparkles" class="shrink-0" aria-hidden="true" />{{ t(`workspace.codebaseHealth.actionLegend`) }}
                        </p>
                    </Card>

                    <Card class="@container flex flex-col gap-3 p-4 @2xl:p-5">
                        <header class="flex flex-col gap-1">
                            <h3 class="text-sm font-semibold text-content">{{ t(`workspace.codebaseHealth.keyModules`) }}</h3>
                            <p class="text-xs leading-relaxed text-muted">{{ t(`workspace.codebaseHealth.rankedByPagerankOver`) }}</p>
                        </header>

                        <p v-if="modules.length === 0" class="py-2 text-xs text-subtle">{{ t(`workspace.codebaseHealth.nothingInRepositoryExports`) }}</p>
                        <!-- No bar here; rank is the claim, not the export count. -->
                        <ul v-else :class="MODULE_COLUMNS">
                            <li
                                v-for="(module, index) in modules"
                                :key="module.path"
                                class="col-span-4 grid min-h-9 grid-cols-subgrid items-center border-b border-line-subtle last:border-b-0"
                            >
                                <button
                                    type="button"
                                    class="col-span-3 -mx-1.5 grid cursor-pointer grid-cols-subgrid items-center rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-overlay"
                                    @click="openFile(module.path)"
                                >
                                    <span class="text-right text-2xs text-subtle tabular-nums">{{ index + 1 }}</span>
                                    <span class="flex min-w-0 flex-col @2xl:flex-row @2xl:items-baseline @2xl:gap-2">
                                        <span class="max-w-full truncate text-xs text-content @2xl:shrink-0" v-tooltip.top.overflow="module.name">{{ module.name }}</span>
                                        <span
                                            v-if="module.dir"
                                            class="min-w-0 truncate text-left text-2xs text-subtle [direction:rtl]"
                                            v-tooltip.top.overflow="module.dir"
                                            ><bdi>{{ folder(module.dir) }}</bdi></span
                                        >
                                    </span>
                                    <span class="text-right text-xs text-muted tabular-nums">{{
                                        t(`workspace.codebaseHealth.exports`, { exports: formatCount(module.exports) })
                                    }}</span>
                                </button>
                                <!-- Only when the module itself is the finding; a healthy chokepoint keeps no action, just a pointer. -->
                                <RefactorAction
                                    v-if="module.ask"
                                    :prompt="module.ask.prompt"
                                    :name="module.name"
                                    :hint="module.ask.hint"
                                    :picker="refactorPick"
                                />
                                <span v-else></span>
                            </li>
                        </ul>
                    </Card>
                </div>
            </div>
        </div>
    </div>
</template>
