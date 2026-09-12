<script setup lang="ts">
import { BarChart, Card, ui, Notice, type NoticeModel, NoticeStack, SegmentedControl, vAction } from "@intentic/ui";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAgents } from "../../agents/fleet/useAgents";
import { relativeTime } from "../../chat/models/catalog";
import { providerDisplayLabel, providerGroup, providerGroupLabel } from "../../chat/accounts/providerCatalog";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSavings } from "./useSavings";
import { useUsage } from "./useUsage";
import PlanLimitsPanel from "./PlanLimitsPanel.vue";
import { compositionOf } from "./savingsChart";
import SavingsCard from "./SavingsCard.vue";
import SavingsStackBar from "./SavingsStackBar.vue";
import UsageColumnChart from "./UsageColumnChart.vue";
import UsageSparkline from "./UsageSparkline.vue";
import {
    cacheHitRate,
    deltaPercent,
    formatCompact,
    formatDelta,
    formatPercent,
    formatUsd,
    formatUsdHero,
    inWindow,
    previousWindow,
    providersIn,
    RANGE_PRESETS,
    type RangePreset,
    rankByCost,
    providerColor,
    rankedBars,
    sparkPoints,
    todayUtc,
    totalsOf,
    totalTokens,
    usageCsv,
    usageSeries,
    windowFor,
} from "./usageChart";

// The Usage tab answers three separate questions, kept visually distinct:
//   - what has this sandbox cost (the never-pruned spend ledger, scoped by the filter row)
//   - how much of your plan is left (account-wide, provider-reported, unaffected by the filters, no dollar figure)
//   - what the token-reduction settings were worth over this window (its own section, needs a period to mean anything)
// Cost and tokens stay separate tiles, never one chart with two y-axes: unrelated scales.

const route = useRoute();
const router = useRouter();
const { rows, isLoading, isFetching, refetch, error } = useUsage();
const outline = useSandboxOutline(isLoading);
const usageNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read this sandbox's usage.`, detail: error.value },
);
const { fleet } = useAgents();

// filters: one row, above everything, scoping everything

const preset = ref<RangePreset>(`30d`);
const providerFilter = ref<string>(`all`);
// Set by the deep link from an agent card (/sandbox/usage?agent=<id>): the whole screen narrows to one agent.
const agentFilter = computed<string | undefined>(() => (typeof route.query[`agent`] === `string` ? route.query[`agent`] : undefined));
const clearAgentFilter = (): void => {
    void router.replace({ name: `sandbox`, params: { tab: `usage` } });
};

// Today in UTC: the ledger's own calendar, so the window bounds and the rows' days can't disagree.
const today = computed(() => todayUtc());
const window = computed(() => windowFor(preset.value, today.value));

const scoped = computed(() =>
    rows.value.filter(
        (row) =>
            (providerFilter.value === `all` || providerGroup(row.provider) === providerFilter.value) &&
            (agentFilter.value === undefined || row.conversationId === agentFilter.value),
    ),
);
const current = computed(() => inWindow(scoped.value, window.value));
const previous = computed(() => {
    const before = previousWindow(window.value);
    return before === undefined ? undefined : inWindow(scoped.value, before);
});

// Lists every provider the ledger has ever seen, not just this window, so options don't appear or vanish as the
// range changes. Folded by `providerGroup` so every locally-run model is one pill, however many deleted cards still own
// an id.
const providerOptions = computed(() => [
    { label: `All providers`, value: `all` },
    ...providersIn(rows.value, providerGroup).map((provider) => ({ label: providerGroupLabel(provider), value: provider })),
]);

// the figures

const totals = computed(() => totalsOf(current.value));
const previousTotals = computed(() => (previous.value === undefined ? undefined : totalsOf(previous.value)));

const seriesProviders = computed(() => providersIn(current.value, providerGroup));
const series = computed(() => usageSeries(current.value, window.value, seriesProviders.value, providerGroup));

const spendDelta = computed(() => deltaPercent(totals.value.costUsd, previousTotals.value?.costUsd));
const turnsDelta = computed(() => deltaPercent(totals.value.turns, previousTotals.value?.turns));
const tokensDelta = computed(() => deltaPercent(totalTokens(totals.value), previousTotals.value && totalTokens(previousTotals.value)));

// Signed and arrowed, never colour alone; up is `warning` (costs money), `danger` stays for real breakage.
const deltaTone = (delta: number | undefined): string =>
    delta === undefined ? `text-subtle` : delta > 0 ? `text-warning` : delta < 0 ? `text-success` : `text-subtle`;
const deltaArrow = (delta: number | undefined): string => (delta === undefined || delta === 0 ? `` : delta > 0 ? `↑` : `↓`);
const comparedTo = computed(() =>
    preset.value === `all` ? undefined : `vs previous ${RANGE_PRESETS.find((entry) => entry.value === preset.value)?.label.toLowerCase() ?? ``}`,
);

// Only counting tiles: a rate would plot 0% on idle days (reads as broken); spend already has its own chart.
const turnPoints = computed(() => sparkPoints(series.value.map((bucket) => bucket.totals.turns)));
const tokenPoints = computed(() => sparkPoints(series.value.map((bucket) => totalTokens(bucket.totals))));

const byModel = computed(() =>
    rankByCost(
        current.value,
        (row) => row.model,
        (key) => key,
        `Provider default`,
        providerGroup,
    ),
);
const agentTitle = (id: string): string => fleet.value.find((agent) => agent.id === id)?.title ?? `${id.slice(0, 8)}…`;
const byAgent = computed(() => rankByCost(current.value, (row) => row.conversationId, agentTitle, `Main tree`, providerGroup));

// savings

// Windowed server-side, unlike the spend rollup: these ledgers are row-per-command, too raw to ship whole.
const { savings } = useSavings(window);
const composition = computed(() => (savings.value === undefined ? undefined : compositionOf(savings.value.input)));
// Hidden entirely rather than showing "nothing yet": furniture on a sandbox that never enabled a cleaner.
const hasSavings = computed(
    () => (savings.value?.input.commands ?? 0) > 0 || savings.value?.search !== undefined || savings.value?.map !== undefined,
);
// States its own period beside the number, since the same digits mean different things under different ranges.
const savingsPeriod = computed(() => (preset.value === `all` ? `all time` : `this range`));

// the table and the export

const tableOpen = ref(false);
const TABLE_LIMIT = 200;
// Newest first: a table is opened to check something recent.
const tableRows = computed(() => current.value.toSorted((left, right) => right.day.localeCompare(left.day)));

const exportCsv = (): void => {
    const blob = new Blob([usageCsv(tableRows.value)], { type: `text/csv;charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement(`a`);
    anchor.href = url;
    anchor.download = `usage-${window.value.from ?? `all`}-to-${window.value.to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
};

const hasSpend = computed(() => current.value.length > 0);
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <Notice v-if="usageNotice" :of="usageNotice" />

        <!-- One filter row scoping everything below; date first, the control every reader reaches for. -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SegmentedControl v-model="preset" :options="RANGE_PRESETS" />
            <span class="h-4 w-px bg-line" />
            <SegmentedControl v-model="providerFilter" :options="providerOptions" size="xs" />
            <button v-if="agentFilter !== undefined" type="button" class="ui-chip gap-1" @click="clearAgentFilter">
                <Icon name="sliders-h" />{{ agentTitle(agentFilter) }}<Icon name="times" />
            </button>
            <button
                type="button"
                :class="ui.iconButton('ml-auto')"
                aria-label="Refresh"
                v-tooltip.top="'Refresh'"
                :disabled="isFetching"
                v-action="() => refetch()"
            >
                <Icon name="refresh" class="text-sm" :spin="isFetching" />
            </button>
        </div>

        <!-- Refetch dims the previous render instead of swapping in skeletons: no layout jump, numbers stay readable. -->
        <div class="flex flex-col gap-6 transition-opacity" :class="isFetching && !isLoading ? `opacity-60` : ``">
            <!--
                Skeleton mirrors the real layout (hero, tiles, chart) so a returning reader recognises it while the ledger
                sums. Not sized to the real figure though: a big grey bar there would read as a failed load, not a wait.
            -->
            <div v-if="isLoading && outline" role="status" aria-busy="true" class="flex flex-col gap-6">
                <span class="sr-only">Reading the ledger…</span>
                <div class="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-4" aria-hidden="true">
                    <Card v-for="tile in 4" :key="tile" class="flex min-w-0 flex-col gap-2">
                        <span class="skeleton block h-2.5 w-16" />
                        <span class="skeleton block" :class="tile === 1 ? `h-8 w-32` : `h-5 w-20`" />
                        <span class="skeleton mt-auto block h-2 w-24" />
                    </Card>
                </div>
                <Card class="flex flex-col gap-3" aria-hidden="true">
                    <div class="flex items-baseline justify-between gap-3">
                        <span class="skeleton block h-3.5 w-32" />
                        <span class="skeleton block h-3.5 w-16" />
                    </div>
                    <!-- Columns of uneven height: a flat row of equal bars is the one thing a real chart never
                         looks like. -->
                    <div class="flex h-28 items-end gap-1.5">
                        <span
                            v-for="(height, index) in [`h-1/3`, `h-2/3`, `h-1/2`, `h-full`, `h-1/4`, `h-3/5`, `h-4/5`, `h-2/5`, `h-3/4`, `h-1/2`]"
                            :key="index"
                            class="skeleton block min-w-0 flex-1"
                            :class="height"
                        />
                    </div>
                </Card>
            </div>

            <!-- `!isLoading`, not just the outline: a still-reading ledger hasn't earned the right to say "never run". -->
            <p v-else-if="!isLoading && rows.length === 0" :class="ui.emptyState(`py-8`)">
                No turns have been billed on this sandbox yet. Spend is recorded at the end of every turn: run an agent and this fills in.
            </p>

            <template v-else-if="!isLoading">
                <!--
                    Spend alone is hero-sized, the rest are stat tiles. Sized against each tile (`@container`+cqi), not the
                    viewport, since a viewport breakpoint measures the wrong thing for whether a figure fits; `truncate` backstops a disagreeing
                    locale.
                -->
                <div class="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-4">
                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">Spend</div>
                        <div class="mt-1 truncate text-[clamp(1.5rem,13cqi,3rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatUsdHero(totals.costUsd) }}
                        </div>
                        <div class="mt-auto flex flex-wrap items-baseline gap-x-1.5 pt-2 text-2xs" :class="deltaTone(spendDelta)">
                            <template v-if="formatDelta(spendDelta) !== undefined">
                                <span class="tabular-nums">{{ deltaArrow(spendDelta) }}{{ formatDelta(spendDelta) }}</span>
                                <span class="text-subtle">{{ comparedTo }}</span>
                            </template>
                            <span v-else class="text-subtle">{{ comparedTo === undefined ? `All time` : `No spend in the previous period` }}</span>
                        </div>
                    </Card>

                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">Turns</div>
                        <div class="mt-1 truncate text-[clamp(1.25rem,9cqi,1.75rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatCompact(totals.turns) }}
                        </div>
                        <div class="mt-1 text-2xs tabular-nums" :class="deltaTone(turnsDelta)">
                            {{ formatDelta(turnsDelta) === undefined ? `—` : `${deltaArrow(turnsDelta)}${formatDelta(turnsDelta)}` }}
                        </div>
                        <UsageSparkline :points="turnPoints" class="mt-auto pt-2 text-subtle" />
                    </Card>

                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">Tokens</div>
                        <div class="mt-1 truncate text-[clamp(1.25rem,9cqi,1.75rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatCompact(totalTokens(totals)) }}
                        </div>
                        <div class="mt-1 text-2xs tabular-nums" :class="deltaTone(tokensDelta)">
                            {{ formatDelta(tokensDelta) === undefined ? `—` : `${deltaArrow(tokensDelta)}${formatDelta(tokensDelta)}` }}
                        </div>
                        <UsageSparkline :points="tokenPoints" class="mt-auto pt-2 text-subtle" />
                    </Card>

                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">Cache hit rate</div>
                        <div class="mt-1 truncate text-[clamp(1.25rem,9cqi,1.75rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatPercent(cacheHitRate(totals)) }}
                        </div>
                        <p class="mt-auto pt-2 text-2xs text-subtle">{{ formatCompact(totals.cacheReadTokens) }} prompt input cached</p>
                    </Card>
                </div>

                <!-- Its own section, not phrased like the tiles above: spend and plan-week-remaining are different questions. -->
                <PlanLimitsPanel />

                <Card>
                    <div class="mb-3 flex items-baseline justify-between gap-3">
                        <h3 class="text-sm font-semibold text-content">Spend per {{ preset === `all` ? `period` : `day` }}</h3>
                        <span class="text-sm tabular-nums text-muted">{{ formatUsd(totals.costUsd) }}</span>
                    </div>
                    <UsageColumnChart v-if="hasSpend" :series="series" :providers="seriesProviders" />
                    <p v-else :class="ui.emptyState()">Nothing was billed in this range.</p>
                </Card>

                <div class="grid gap-3 @2xl:grid-cols-2">
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">Cost by model</h3>
                        <BarChart v-if="byModel.length > 0" :items="rankedBars(byModel)" :label-width="8" />
                        <p v-else :class="ui.emptyState()">Nothing was billed in this range.</p>
                    </Card>
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">Cost by agent</h3>
                        <BarChart v-if="byAgent.length > 0" :items="rankedBars(byAgent)" :label-width="8" />
                        <p v-else :class="ui.emptyState()">Nothing was billed in this range.</p>
                    </Card>
                </div>

                <!--
                    Separate cards, not one ranking: one is measured exactly, the other is an experiment needing a control and
                    margin, mixing would lend it false confidence. Different units of value too (a saved tool token compounds, an output token
                    doesn't), so none total into another; each shares one shape (SavingsCard) and the grid is container-based, not viewport.
                -->
                <section v-if="hasSavings" class="@container">
                    <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
                        <span :class="ui.sectionLabel()">Token savings</span>
                    </div>

                    <!--
                        `items-start`: a short card stays short, not stretched to the tallest. Two columns: the composition card spans
                        the left column's height, the two experiment cards stack beside it (plain flow would leave a gap under one).
                    -->
                    <div class="grid items-start gap-3 @2xl:grid-cols-2">
                        <SavingsCard
                            title="Tool output → assistant"
                            :value="`${savings?.input.savedPct ?? 0}%`"
                            unit="of shell output removed"
                            tone="success"
                        >
                            <template #hint>
                                Every command carries its own raw baseline, so this is realized, not estimated. Each stage is weighed against what
                                reached it: sequential attribution, which is what makes the parts sum to the whole and lets them be stacked at all. It
                                is not "what turning this cleaner off would cost you": the cap downstream would have eaten some of the same lines. The
                                retrieval footers are the price of the trimming being reversible: the pointers that let the agent grep the full output
                                back.
                            </template>

                            <SavingsStackBar v-if="composition !== undefined && composition.rawTokens > 0" :composition="composition" />
                            <p v-else :class="ui.emptyState()">No shell output was cleaned in this range.</p>

                            <!-- Whole-pipeline counterfactual (commands left raw at random), unlike the rest of this card's attribution. -->
                            <p v-if="savings?.input.holdout.measuredSavedPct !== undefined" class="mt-2 text-2xs text-muted">
                                Holdout control
                                <span class="tabular-nums text-content">{{ savings.input.holdout.measuredSavedPct }}%</span>: measured against
                                {{ savings.input.holdout.heldOut }} of {{ savings.input.holdout.heldOut + savings.input.holdout.cleaned }} commands
                                left raw at random.
                            </p>

                            <!-- Age stated always: a frozen figure reads exactly like a live one otherwise. -->
                            <template #footnote>
                                {{ formatCompact(savings?.input.commands ?? 0) }} commands · {{ savingsPeriod }}
                                <template v-if="savings?.input.updatedAt !== undefined"
                                    >· last command {{ relativeTime(savings.input.updatedAt) }}</template
                                >
                            </template>
                        </SavingsCard>
                    </div>
                </section>

                <!-- How a distrusted number gets reconciled, and what discharges the palette's low-contrast fills. -->
                <Card>
                    <div class="flex items-center justify-between gap-3">
                        <button type="button" class="flex cursor-pointer items-center gap-1.5 text-sm text-content" @click="tableOpen = !tableOpen">
                            <Icon :name="tableOpen ? `chevron-down` : `chevron-right`" class="text-muted" />
                            Show table
                            <span class="text-2xs text-subtle">{{ tableRows.length }} rows · {{ formatCompact(totals.turns) }} turns</span>
                        </button>
                        <button type="button" :class="ui.linkButton(`gap-1 text-2xs`)" :disabled="tableRows.length === 0" @click="exportCsv">
                            <Icon name="download" />Export CSV
                        </button>
                    </div>

                    <div v-if="tableOpen" class="scrollbar-thin mt-3 overflow-x-auto">
                        <table class="w-full text-2xs">
                            <thead class="text-left text-subtle">
                                <tr class="border-b border-line-subtle">
                                    <th class="py-1.5 pr-3 font-medium">Day</th>
                                    <th class="py-1.5 pr-3 font-medium">Provider</th>
                                    <th class="py-1.5 pr-3 font-medium">Model</th>
                                    <th class="py-1.5 pr-3 font-medium">Agent</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">Turns</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">In</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">Out</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">Cached</th>
                                    <th class="py-1.5 text-right font-medium">Cost</th>
                                </tr>
                            </thead>
                            <tbody class="tabular-nums text-muted">
                                <tr v-for="(row, index) in tableRows.slice(0, TABLE_LIMIT)" :key="index" class="border-b border-line/50">
                                    <td class="py-1.5 pr-3 whitespace-nowrap">{{ row.day }}</td>
                                    <!--
                                        Swatch is the series (matches the chart/legend), the name is the actual billing card: folding locals into one
                                        word here would hide which one, unlike the chart above.
                                    -->
                                    <td class="py-1.5 pr-3">
                                        <span class="flex items-center gap-1.5">
                                            <span
                                                class="size-2 shrink-0 rounded-2xs"
                                                :style="{ background: providerColor(providerGroup(row.provider)) }"
                                            />
                                            {{ providerDisplayLabel(row.provider) }}
                                        </span>
                                    </td>
                                    <td class="py-1.5 pr-3">{{ row.model ?? `—` }}</td>
                                    <td class="max-w-40 truncate py-1.5 pr-3">
                                        {{ row.conversationId === undefined ? `Main tree` : agentTitle(row.conversationId) }}
                                    </td>
                                    <td class="py-1.5 pr-3 text-right">{{ row.turns }}</td>
                                    <td class="py-1.5 pr-3 text-right">{{ formatCompact(row.inputTokens) }}</td>
                                    <td class="py-1.5 pr-3 text-right">{{ formatCompact(row.outputTokens) }}</td>
                                    <td class="py-1.5 pr-3 text-right">{{ formatCompact(row.cacheReadTokens) }}</td>
                                    <td class="py-1.5 text-right text-content">{{ formatUsd(row.costUsd) }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <!-- Never silently truncate a money table: say what was cut, and where the rest is. -->
                        <p v-if="tableRows.length > TABLE_LIMIT" class="mt-2 text-2xs text-subtle">
                            Showing the {{ TABLE_LIMIT }} most recent of {{ tableRows.length }} rows: export the CSV for all of them.
                        </p>
                    </div>
                </Card>
            </template>
        </div>
    </div>
</template>
