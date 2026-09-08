<script setup lang="ts">
import { Picker, SegmentedControl } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { useCodebaseHealth } from "./useCodebaseHealth";
import { useRepos } from "../explorer/useRepos";
import { type ChurnWindow, CHURN_WINDOWS, formatCount, hotspotRows, moduleRows, perFile } from "./codebaseHealth";

// Repo-level surface beside the management panel (cog) and git history (graph); answers where the risk sits,
// via hotspots (churn x complexity) and map (PageRank over imports). Every number is a count a reader can
// recount, never a grade, so a row opens a file, not a score. Its action hands that file to an agent, using the row's
// own numbers.

const { repo } = defineProps<{ repo: string }>();
const emit = defineEmits<{ "open-file": [path: string]; "switch-repo": [repo: string] }>();

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
                aria-label="Repository"
                @update:model-value="(value: string | undefined) => value !== undefined && emit('switch-repo', value)"
            />
            <span v-else class="text-xs font-medium text-content">{{ repo }}</span>
            <span class="flex-1"></span>
            <!-- The window narrows churn only; complexity reflects the file as it stands today and doesn't move with it. -->
            <span class="shrink-0 text-2xs text-subtle">Commits from</span>
            <SegmentedControl v-model="churnWindow" size="xs" :options="CHURN_WINDOWS" />
            <button
                type="button"
                class="flex shrink-0 items-center rounded-md px-1 py-0.5 text-muted transition-colors hover:text-content"
                v-tooltip.bottom="'Recompute from the current index'"
                aria-label="Refresh codebase health"
                @click="refresh()"
            >
                <Icon name="refresh" class="text-2xs" />
            </button>
            <Icon v-if="loading" name="spinner" class="shrink-0 text-2xs text-subtle" spin />
        </div>

        <p v-if="error" class="shrink-0 truncate px-3 py-1 text-2xs text-danger" v-tooltip.bottom.overflow="error">{{ error }}</p>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto px-3 py-3">
            <p v-if="totals === undefined" class="py-3 text-2xs text-subtle">{{ loading ? "Reading the index…" : "No report yet." }}</p>
            <template v-else>
                <p v-if="building" class="mb-3 flex items-center gap-1.5 text-2xs text-warning">
                    <Icon name="exclamation-triangle" class="shrink-0 text-[0.65rem]" />
                    The index is still building: these figures cover only what has been read so far.
                </p>

                <dl class="grid grid-cols-2 gap-2 @xl:grid-cols-4">
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">Files</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.files) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">indexed, ignoring build output</p>
                    </div>
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">Symbols</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.symbols) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">functions, types, classes</p>
                    </div>
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">Branch points</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.complexity) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">{{ perFile(totals.complexity, totals.files) }} per file</p>
                    </div>
                    <div class="min-w-0 rounded-md border border-line bg-card px-3 py-2">
                        <dt class="text-2xs text-muted">Hotspots</dt>
                        <dd class="mt-0.5 truncate text-lg font-semibold leading-none text-content">{{ formatCount(totals.hotspots) }}</dd>
                        <p class="mt-1 text-2xs text-subtle">files with both churn and branching</p>
                    </div>
                </dl>

                <section class="mt-4">
                    <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">
                        Hotspots<span v-if="totals.hotspots > rows.length" class="ml-1 normal-case tracking-normal">
                            · top {{ rows.length }} of {{ formatCount(totals.hotspots) }}</span
                        >
                    </h2>
                    <p class="mt-0.5 text-2xs text-subtle">
                        Commits × branch points. Neither alone is a warning: a churning config file is trivial, and a tangled file nobody touches
                        costs nobody anything. Open a row to read the file, or
                        <Icon name="sparkles" class="text-[0.65rem]" aria-hidden="true" /> to start an agent refactoring it.
                    </p>
                    <p v-if="rows.length === 0" class="py-3 text-2xs text-subtle">
                        No file here has both commits and branch points: a repository with no history yet, or one holding only markup and config,
                        ranks nothing.
                    </p>
                    <template v-else>
                        <!-- Track kept open in the header too, so columns don't shift when a row's action fades in on hover. -->
                        <div class="mt-2 flex items-center gap-2 px-1 pb-1 text-2xs text-subtle">
                            <div :class="`${ROW_CLASS} min-w-0 flex-1`">
                                <span></span>
                                <span></span>
                                <span>risk</span>
                                <span class="text-right">commits</span>
                                <span class="text-right">branches</span>
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
                                <button type="button" :class="`${ROW_CLASS} min-w-0 flex-1 text-left`" @click="emit('open-file', row.path)">
                                    <span class="text-2xs tabular-nums text-subtle">{{ index + 1 }}</span>
                                    <!-- Truncation lands on the directory, not the filename; the directory alone gets a tooltip, only when cut off. -->
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
                                <!-- Hidden until hover except on touch; a dormant row keeps the action but dimmed, with a tooltip explaining why. -->
                                <button
                                    type="button"
                                    class="shrink-0 cursor-pointer transition-colors md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
                                    :class="row.ask.dormant ? 'text-subtle hover:text-muted' : 'text-muted hover:text-link'"
                                    v-tooltip.top="row.ask.hint"
                                    :aria-label="`Refactor ${row.name}`"
                                    @click="startAgent(row.ask.prompt)"
                                >
                                    <Icon name="sparkles" class="w-4 text-2xs" />
                                </button>
                            </li>
                        </ul>
                    </template>
                </section>

                <section class="mt-5">
                    <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">Key modules</h2>
                    <p class="mt-0.5 text-2xs text-subtle">
                        Ranked by PageRank over the import graph: what the rest of this repository leans on, which is rarely what the file tree puts
                        first.
                    </p>
                    <p v-if="modules.length === 0" class="py-3 text-2xs text-subtle">Nothing in this repository exports a symbol the index reads.</p>
                    <!-- No bar here; rank is the claim, not the export count. -->
                    <ul v-else class="mt-2 flex flex-col">
                        <li
                            v-for="(module, index) in modules"
                            :key="module.path"
                            class="group/row flex items-center gap-2 rounded px-1 py-1 transition-colors hover:bg-overlay"
                        >
                            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" @click="emit('open-file', module.path)">
                                <span class="w-5 shrink-0 text-2xs tabular-nums text-subtle">{{ index + 1 }}</span>
                                <span class="flex min-w-0 flex-1 overflow-hidden text-xs">
                                    <span class="truncate text-subtle" v-tooltip.top.overflow="module.dir">{{ module.dir }}</span>
                                    <span class="shrink-0 text-content">{{ module.name }}</span>
                                </span>
                                <span class="shrink-0 text-2xs tabular-nums text-muted">{{ formatCount(module.exports) }} exports</span>
                            </button>
                            <!-- Shown only when the module itself is the finding; a healthy chokepoint keeps no action, just a pointer. -->
                            <button
                                v-if="module.ask"
                                type="button"
                                class="shrink-0 cursor-pointer text-muted transition-colors hover:text-link md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
                                v-tooltip.top="module.ask.hint"
                                :aria-label="`Refactor ${module.name}`"
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
