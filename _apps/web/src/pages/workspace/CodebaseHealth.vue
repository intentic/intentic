<script setup lang="ts">
import { Picker, Segmented } from "@intentic/ui";
import { computed, ref } from "vue";
import { startAgent } from "../../composables/agents/agentActions";
import { useCodebaseHealth } from "../../composables/workspace/useCodebaseHealth";
import { useRepos } from "../../composables/workspace/useRepos";
import { type ChurnWindow, CHURN_WINDOWS, formatCount, hotspotRows, moduleRows, perFile } from "./codebaseHealth";

/* One repo's codebase health — the third repository-level surface, beside its management panel (the cog) and
 * its git history (the graph). Where the graph answers "what happened here", this answers "where does the risk
 * sit, and what holds this repo together": the daemon's resident iq engine ranks churn × complexity
 * (`hotspots`) and PageRank over the import graph (`map`), and this plots what the CLI prints.
 *
 * Every number here is a COUNT, never a grade. Branch points, commits, exported symbols: figures a reader can
 * go and recount in the files. A composite "maintainability score" would be unfalsifiable, not comparable
 * between repos, and would quietly replace the reader's judgement with the tool's — the ranking exists to send
 * someone to a FILE, which is why every row here opens one.
 *
 * The second thing a row can do is hand that file to an agent. It is the SAME claim acted on rather than read:
 * the prompt quotes the row's own numbers and nothing else, and which refactor it asks for is derived from
 * them (refactorAsk.ts). The user still picks the row — the ranking never picks it for them, which is why the
 * action rides on the row instead of standing at the top of the panel as a "fix my repo" button. */

const { repo } = defineProps<{ repo: string }>();
const emit = defineEmits<{ "open-file": [path: string]; "switch-repo": [repo: string] }>();

const repoRef = computed(() => repo);
const churnWindow = ref<ChurnWindow>(`all`);
const { health, loading, error, refresh } = useCodebaseHealth(repoRef, churnWindow);
const { options } = useRepos();

const totals = computed(() => health.value?.totals);
// Dormancy is measured from the read, not from a ticking clock: this recomputes whenever the report or the
// window does, and no posture here turns on anything finer than a season.
const rows = computed(() => hotspotRows(health.value?.hotspots ?? [], health.value?.modules ?? [], churnWindow.value, Date.now()));
const modules = computed(() => moduleRows(health.value?.modules ?? []));
// The index is built in the background, so a panel opened right after boot can be reading a partial one. Saying
// so beats rendering "0 symbols" as if it were a fact about the repository.
const building = computed(() => health.value?.freshness.state === `building`);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col bg-canvas text-content">
        <!-- Header: repo switcher · churn window · refresh — the same shape as the graph's, one surface over. -->
        <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-card px-3">
            <Icon name="wave-pulse" class="shrink-0 text-xs text-subtle" />
            <!-- Switching navigates between per-repo health tabs, exactly as the graph's switcher does. -->
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
            <!-- The window narrows CHURN only: complexity is a property of the file as it stands today, so it
                 never moves when this does. -->
            <span class="shrink-0 text-2xs text-subtle">Commits from</span>
            <Segmented v-model="churnWindow" size="xs" :options="CHURN_WINDOWS" />
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
                    The index is still building — these figures cover only what has been read so far.
                </p>

                <!-- What the index holds, as four counts. Not a chart: a handful of headline numbers is a
                     stat-tile row, and a bar chart of four unrelated scales would say less. -->
                <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                        Commits × branch points. Neither alone is a warning — a churning config file is trivial, and a tangled file nobody touches
                        costs nobody anything. Open a row to read the file, or
                        <Icon name="sparkles" class="text-[0.65rem]" aria-hidden="true" /> to start an agent refactoring it.
                    </p>
                    <p v-if="rows.length === 0" class="py-3 text-2xs text-subtle">
                        No file here has both commits and branch points — a repository with no history yet, or one holding only markup and config,
                        ranks nothing.
                    </p>
                    <template v-else>
                        <!-- The action's track is held open in the header too, so the columns below it stay put
                             whether or not a row is being hovered. -->
                        <div class="row-line mt-2 px-1 pb-1 text-2xs text-subtle">
                            <div class="hs-row min-w-0 flex-1">
                                <span></span>
                                <span></span>
                                <span>risk</span>
                                <span class="text-right">commits</span>
                                <span class="text-right">branches</span>
                            </div>
                            <span class="w-4 shrink-0"></span>
                        </div>
                        <ul class="flex flex-col">
                            <li v-for="(row, index) in rows" :key="row.path" class="row-line group/row rounded px-1 py-1 hover:bg-overlay">
                                <!-- One hue for every bar: length is the whole message, and a colour keyed to the
                                     bar's own size would double-encode it. Text keeps text tokens throughout. -->
                                <button type="button" class="hs-row min-w-0 flex-1 text-left" @click="emit('open-file', row.path)">
                                    <span class="text-2xs tabular-nums text-subtle">{{ index + 1 }}</span>
                                    <!-- The DIRECTORY takes the truncation; the filename is what identifies the
                                         row, so it never shrinks — and it is the directory, not the row, that
                                         earns a tooltip, and only while it is actually cut off. -->
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
                                <!-- Out of the scan until the row is hovered, on a pointer device: the ranking is
                                     what this panel is for, and twenty always-lit buttons would read as twenty
                                     things to do. Touch has no hover, so there it stays put. A dormant row keeps
                                     the action but dims it — the tooltip says why it probably isn't worth it,
                                     and the user may still know something the git log doesn't. -->
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
                        Ranked by PageRank over the import graph — what the rest of this repository leans on, which is rarely what the file tree puts
                        first.
                    </p>
                    <p v-if="modules.length === 0" class="py-3 text-2xs text-subtle">Nothing in this repository exports a symbol the index reads.</p>
                    <!-- No bar here: the RANK is the claim, and export counts are not a magnitude worth drawing. -->
                    <ul v-else class="mt-2 flex flex-col">
                        <li v-for="(module, index) in modules" :key="module.path" class="row-line group/row rounded px-1 py-1 hover:bg-overlay">
                            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" @click="emit('open-file', module.path)">
                                <span class="w-5 shrink-0 text-2xs tabular-nums text-subtle">{{ index + 1 }}</span>
                                <span class="flex min-w-0 flex-1 overflow-hidden text-xs">
                                    <span class="truncate text-subtle" v-tooltip.top.overflow="module.dir">{{ module.dir }}</span>
                                    <span class="shrink-0 text-content">{{ module.name }}</span>
                                </span>
                                <span class="shrink-0 text-2xs tabular-nums text-muted">{{ formatCount(module.exports) }} exports</span>
                            </button>
                            <!-- Only where the SURFACE is the finding. The top of a PageRank ranking is also where
                                 a healthy chokepoint lives — an index.ts everything imports and that exports four
                                 things is the shape you want — so most rows here keep the empty track and stay
                                 what they are: a pointer at a file. -->
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

<style scoped>
/* A row is the ranking plus its action, side by side — the ranking a button that opens the file, the action a
   button of its own beside it, because one cannot nest inside the other. The hover tint lives out here so that
   reaching for the action still lights the row it belongs to. */
.row-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: background-color 150ms;
}

/* Header and rows share one track list so the columns line up. The bar column is fixed rather than fluid: a
   ranked bar is compared against its neighbours, and a column that grows with the panel would rescale the
   comparison every time the sidebar moves. */
.hs-row {
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr) 8rem 3.5rem 4rem;
    align-items: center;
    gap: 0.5rem;
}
</style>
