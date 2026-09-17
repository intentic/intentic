<script setup lang="ts">
import { Picker, SegmentedControl } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { useCodebaseHealth } from "./useCodebaseHealth";
import { useRepos } from "../explorer/useRepos";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { type ChurnWindow, churnWindows, formatCount, hotspotRows, moduleRows, perFile } from "./codebaseHealth";
import { useT } from "@intentic/ui/i18n";

// A repository's Health tab in the management panel, and the workspace root's own health tab; answers where the risk
// sits, via hotspots (churn x complexity) and map (PageRank over imports). Every number is a count a reader can
// recount, never a grade, so a row opens a file, not a score. Its action hands that file to an agent, using the row's
// own numbers.

const t = useT();

const { repo } = defineProps<{ repo: string }>();
// Opens through the tab store rather than an emit: the management panel mounts this view through ExtensionView, which
// binds props and listens to nothing.
const { openFile, openHealth } = useWorkspaceTabs();

const repoRef = computed(() => repo);
const churnWindow = ref<ChurnWindow>(`all`);
const { health, loading, error, refresh } = useCodebaseHealth(repoRef, churnWindow);
const { options } = useRepos();

const totals = computed(() => health.value?.totals);
// Dormancy is measured from the read, not a live clock; recomputes only when the report or window changes.
const rows = computed(() => hotspotRows(health.value?.hotspots ?? [], health.value?.modules ?? [], churnWindow.value, Date.now()));
const modules = computed(() => moduleRows(health.value?.modules ?? []));
// Index builds in the background; a fresh panel may read a partial one, so this says so instead of showing 0.
const building = computed(() => health.value?.freshness.state === `building`);
// Shared by the header and each row so columns align; the bar column is fixed so a resize can't rescale it.
const ROW_CLASS = `grid grid-cols-[1.25rem_minmax(0,1fr)_8rem_3.5rem_4rem] items-center gap-2`;
</script>

<template>
    <div class="@container flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Header: repo switcher, churn window, refresh. -->
        <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-card px-3">
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
            <span v-else class="text-xs font-medium text-content">{{ repo }}</span>
            <span class="flex-1"></span>
            <!-- The window narrows churn only; complexity reflects the file as it stands today and doesn't move with it. -->
            <span class="shrink-0 text-2xs text-subtle">{{ t(`workspace.codebaseHealth.commits`) }}</span>
            <SegmentedControl v-model="churnWindow" size="xs" :options="churnWindows()" />
            <button
                type="button"
                class="flex shrink-0 items-center rounded-md px-1 py-0.5 text-muted transition-colors hover:text-content"
                v-tooltip.bottom="t(`workspace.codebaseHealth.recomputeCurrentIndex`)"
                :aria-label="t(`workspace.codebaseHealth.refreshCodebaseHealth`)"
                @click="refresh()"
            >
                <Icon name="refresh" class="text-2xs" />
            </button>
            <Icon v-if="loading" name="spinner" class="shrink-0 text-2xs text-subtle" spin />
        </div>

        <p v-if="error" class="shrink-0 truncate px-3 py-1 text-2xs text-danger" v-tooltip.bottom.overflow="error">{{ error }}</p>

        <div class="min-h-0 flex-1 overflow-auto px-3 py-3">
            <p v-if="totals === undefined" class="py-3 text-2xs text-subtle">
                {{ loading ? t(`workspace.codebaseHealth.readingIndex`) : t(`workspace.codebaseHealth.noReportYet`) }}
            </p>
            <template v-else>
                <p v-if="building" class="mb-3 flex items-center gap-1.5 text-2xs text-warning">
                    <Icon name="exclamation-triangle" class="shrink-0 text-[0.65rem]" />
                    {{ t(`workspace.codebaseHealth.indexStillBuildingFigures`) }}
                </p>

                <dl class="grid grid-cols-2 gap-2 @xl:grid-cols-4">
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">{{ t(`workspace.codebaseHealth.files`) }}</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.files) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">{{ t(`workspace.codebaseHealth.indexedIgnoringBuildOutput`) }}</p>
                    </div>
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">{{ t(`workspace.codebaseHealth.symbols`) }}</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.symbols) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">{{ t(`workspace.codebaseHealth.functionsTypesClasses`) }}</p>
                    </div>
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">{{ t(`workspace.codebaseHealth.branchPoints`) }}</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.complexity) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">
                            {{ t(`workspace.codebaseHealth.perFile`, { files: perFile(totals.complexity, totals.files) }) }}
                        </p>
                    </div>
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">{{ t(`workspace.codebaseHealth.hotspots`) }}</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.hotspots) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">{{ t(`workspace.codebaseHealth.filesBothChurnBranching`) }}</p>
                    </div>
                </dl>

                <section class="mt-4">
                    <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">
                        {{ t(`workspace.codebaseHealth.hotspots`)
                        }}<span v-if="totals.hotspots > rows.length" class="ml-1 normal-case tracking-normal">{{
                            t(`workspace.codebaseHealth.top`, { count: rows.length, hotspots: formatCount(totals.hotspots) })
                        }}</span>
                    </h2>
                    <p class="mt-0.5 text-2xs text-subtle">
                        {{ t(`workspace.codebaseHealth.commitsBranchPointsNeither`) }}
                        <Icon name="sparkles" class="text-[0.65rem]" aria-hidden="true" /> {{ t(`workspace.codebaseHealth.toStartAgentRefactoring`) }}
                    </p>
                    <p v-if="rows.length === 0" class="py-3 text-2xs text-subtle">
                        {{ t(`workspace.codebaseHealth.noFileHereBoth`) }}
                    </p>
                    <template v-else>
                        <!-- Track kept open in the header too, so columns don't shift when a row's action fades in on hover. -->
                        <div class="mt-2 flex items-center gap-2 px-1 pb-1 text-2xs text-subtle">
                            <div :class="`${ROW_CLASS} min-w-0 flex-1`">
                                <span></span>
                                <span></span>
                                <span>{{ t(`workspace.codebaseHealth.risk`) }}</span>
                                <span class="text-right">{{ t(`workspace.codebaseHealth.commits2`) }}</span>
                                <span class="text-right">{{ t(`workspace.codebaseHealth.branches`) }}</span>
                            </div>
                            <span class="w-4 shrink-0"></span>
                        </div>
                        <ul class="flex flex-col">
                            <li
                                v-for="(row, index) in rows"
                                :key="row.path"
                                class="group/row flex items-center gap-2 rounded px-1 py-1 transition-colors hover:bg-overlay"
                            >
                                <!-- One hue for every bar; length already encodes magnitude, so color must not. -->
                                <button type="button" :class="`${ROW_CLASS} min-w-0 flex-1 text-left`" @click="openFile(row.path)">
                                    <span class="text-2xs tabular-nums text-subtle">{{ index + 1 }}</span>
                                    <!-- Truncate directories separately so filenames remain readable. -->
                                    <span class="flex min-w-0 overflow-hidden text-xs">
                                        <span class="truncate text-subtle" v-tooltip.top.overflow="row.dir">{{ row.dir }}</span>
                                        <span class="shrink-0 text-content">{{ row.name }}</span>
                                    </span>
                                    <span class="h-1.5 rounded-full bg-overlay">
                                        <span
                                            class="block h-full rounded-full"
                                            :style="{ width: `${row.share * 100}%`, background: `var(--color-series-2)` }"
                                        />
                                    </span>
                                    <span class="text-right text-2xs tabular-nums text-muted">{{ formatCount(row.commits) }}</span>
                                    <span class="text-right text-2xs tabular-nums text-muted">{{ formatCount(row.complexity) }}</span>
                                </button>
                                <!-- Dormant actions stay dimmed and appear on hover or touch. -->
                                <button
                                    type="button"
                                    class="shrink-0 cursor-pointer transition-colors md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
                                    :class="row.ask.dormant ? 'text-subtle hover:text-muted' : 'text-muted hover:text-link'"
                                    v-tooltip.top="row.ask.hint"
                                    :aria-label="t(`workspace.codebaseHealth.refactor`, { name: row.name })"
                                    @click="startAgent(row.ask.prompt)"
                                >
                                    <Icon name="sparkles" class="w-4 text-2xs" />
                                </button>
                            </li>
                        </ul>
                    </template>
                </section>

                <section class="mt-5">
                    <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`workspace.codebaseHealth.keyModules`) }}</h2>
                    <p class="mt-0.5 text-2xs text-subtle">
                        {{ t(`workspace.codebaseHealth.rankedByPagerankOver`) }}
                    </p>
                    <p v-if="modules.length === 0" class="py-3 text-2xs text-subtle">
                        {{ t(`workspace.codebaseHealth.nothingInRepositoryExports`) }}
                    </p>
                    <!-- No bar here; rank is the claim, not the export count. -->
                    <ul v-else class="mt-2 flex flex-col">
                        <li
                            v-for="(module, index) in modules"
                            :key="module.path"
                            class="group/row flex items-center gap-2 rounded px-1 py-1 transition-colors hover:bg-overlay"
                        >
                            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" @click="openFile(module.path)">
                                <span class="w-5 shrink-0 text-2xs tabular-nums text-subtle">{{ index + 1 }}</span>
                                <span class="flex min-w-0 flex-1 overflow-hidden text-xs">
                                    <span class="truncate text-subtle" v-tooltip.top.overflow="module.dir">{{ module.dir }}</span>
                                    <span class="shrink-0 text-content">{{ module.name }}</span>
                                </span>
                                <span class="shrink-0 text-2xs tabular-nums text-muted">{{
                                    t(`workspace.codebaseHealth.exports`, { exports: formatCount(module.exports) })
                                }}</span>
                            </button>
                            <!-- Shown only when the module itself is the finding; a healthy chokepoint keeps no action, just a pointer. -->
                            <button
                                v-if="module.ask"
                                type="button"
                                class="shrink-0 cursor-pointer text-muted transition-colors hover:text-link md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
                                v-tooltip.top="module.ask.hint"
                                :aria-label="t(`workspace.codebaseHealth.refactor`, { name: module.name })"
                                @click="startAgent(module.ask.prompt)"
                            >
                                <Icon name="sparkles" class="w-4 text-2xs" />
                            </button>
                            <span v-else class="w-4 shrink-0"></span>
                        </li>
                    </ul>
                </section>
            </template>
        </div>
    </div>
</template>
