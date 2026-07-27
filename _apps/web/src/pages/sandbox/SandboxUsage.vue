<script setup lang="ts">
import { Card, cmp, Segmented } from "@intentic-app/ui";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import { useAgents } from "../../composables/agents/useAgents";
import { providerAccounts } from "../../composables/chat/conversation";
import {
    formatAge,
    formatReset,
    formatUtilization,
    isStale,
    orderedWindows,
    usagePercent,
    usageStatusByAccount,
    usageTone,
    usageWindowLabel,
} from "../../composables/chat/usageStatus";
import { useUsage } from "../../composables/sandbox/useUsage";
import UsageBarChart from "./UsageBarChart.vue";
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
    providerLabel,
    providersIn,
    RANGE_PRESETS,
    type RangePreset,
    rankByCost,
    seriesColor,
    sparkPoints,
    todayUtc,
    totalsOf,
    totalTokens,
    usageCsv,
    usageSeries,
    windowFor,
} from "./usageChart";

/* The Sandbox hub's "Usage" tab. It answers two questions with DIFFERENT SUBJECTS, and keeping them apart is
 * most of the design:
 *
 *   - What has this sandbox cost? Every figure is a projection of one durable source — the daemon's never-pruned
 *     spend ledger (usage/usage-store.ts) — so a total can't shrink as the sandbox gets busier, which is exactly
 *     what the old activity-log aggregation did. Scoped by the filter row.
 *   - How much of your PLAN is left? Account-wide, provider-reported, unaffected by every filter above it, and
 *     not a share of the spend either: a Max plan's weekly pool has no dollar figure at all.
 *
 * So the plan-limit meters are their own section with their own subject stated in the label — an earlier version
 * of this tab put a bare "1%" under the spend tiles and invited reading it as a budget, on an account that was
 * really 98% through its week.
 *
 * Cost and tokens stay two tiles for the same reason: unrelated scales, never one chart with two y-axes. */

const route = useRoute();
const router = useRouter();
const { rows, isLoading, isFetching, refetch, error } = useUsage();
const { fleet } = useAgents();

// ---- filters: one row, above everything, scoping everything -----------------------------------------------

const preset = ref<RangePreset>(`30d`);
const providerFilter = ref<string>(`all`);
// Set by the deep link from an agent card (/sandbox/usage?agent=<id>) — the whole screen narrows to one agent.
const agentFilter = computed<string | undefined>(() => (typeof route.query[`agent`] === `string` ? route.query[`agent`] : undefined));
const clearAgentFilter = (): void => {
    void router.replace({ name: `sandbox`, params: { tab: `usage` } });
};

// Today in UTC — the ledger's own calendar, so the window bounds and the rows' days can't disagree.
const today = computed(() => todayUtc());
const window = computed(() => windowFor(preset.value, today.value));

const scoped = computed(() =>
    rows.value.filter(
        (row) =>
            (providerFilter.value === `all` || row.provider === providerFilter.value) &&
            (agentFilter.value === undefined || row.conversationId === agentFilter.value),
    ),
);
const current = computed(() => inWindow(scoped.value, window.value));
const previous = computed(() => {
    const before = previousWindow(window.value);
    return before === undefined ? undefined : inWindow(scoped.value, before);
});

// Provider pills list every provider the LEDGER has ever seen, not just the current window — a filter whose
// options appear and vanish as you change the date range is unusable.
const providerOptions = computed(() => [
    { label: `All providers`, value: `all` },
    ...providersIn(rows.value).map((provider) => ({ label: providerLabel(provider), value: provider })),
]);

// ---- the figures ------------------------------------------------------------------------------------------

const totals = computed(() => totalsOf(current.value));
const previousTotals = computed(() => (previous.value === undefined ? undefined : totalsOf(previous.value)));

const seriesProviders = computed(() => providersIn(current.value));
const series = computed(() => usageSeries(current.value, window.value, seriesProviders.value));

const spendDelta = computed(() => deltaPercent(totals.value.costUsd, previousTotals.value?.costUsd));
const turnsDelta = computed(() => deltaPercent(totals.value.turns, previousTotals.value?.turns));
const tokensDelta = computed(() => deltaPercent(totalTokens(totals.value), previousTotals.value && totalTokens(previousTotals.value)));

// A stat tile's delta is signed AND arrowed, so direction never rests on colour alone. On a cost screen up is
// the direction that costs money — warning, not danger, which stays reserved for things that actually broke.
const deltaTone = (delta: number | undefined): string =>
    delta === undefined ? `text-subtle` : delta > 0 ? `text-warning` : delta < 0 ? `text-success` : `text-subtle`;
const deltaArrow = (delta: number | undefined): string => (delta === undefined || delta === 0 ? `` : delta > 0 ? `↑` : `↓`);
const comparedTo = computed(() =>
    preset.value === `all` ? undefined : `vs previous ${RANGE_PRESETS.find((entry) => entry.value === preset.value)?.label.toLowerCase() ?? ``}`,
);

// Sparklines only on the counting tiles. A cache-hit RATE would have to plot 0% on every idle day, which reads
// as "caching stopped working" rather than "nothing ran" — and spend already has the full-resolution chart
// below, so a second, coarser copy of it would just be redundant ink.
const turnPoints = computed(() => sparkPoints(series.value.map((bucket) => bucket.totals.turns)));
const tokenPoints = computed(() => sparkPoints(series.value.map((bucket) => totalTokens(bucket.totals))));

const byModel = computed(() =>
    rankByCost(
        current.value,
        (row) => row.model,
        (key) => key,
        `Provider default`,
    ),
);
const agentTitle = (id: string): string => fleet.value.find((agent) => agent.id === id)?.title ?? `${id.slice(0, 8)}…`;
const byAgent = computed(() => rankByCost(current.value, (row) => row.conversationId, agentTitle, `Main tree`));

// ---- plan limits --------------------------------------------------------------------------------------------

// Every connected account that has reported its plan limits, across providers, with each of its pools rounded
// once here so the meter and its label can't disagree. Claude is the only provider that reports limits today, so
// this is short by construction — and an account that has never run a turn is absent rather than shown at a
// confident 0%.
const headroom = computed(() =>
    Object.entries(providerAccounts.value)
        .flatMap(([provider, accounts]) =>
            accounts.flatMap((account) => {
                const usage = usageStatusByAccount.value[account.id];
                const percent = usagePercent(usage);
                if (usage === undefined || percent === undefined) {
                    return [];
                }
                // A row per pool, rounded once here so the meter's width and its printed number can't disagree.
                const pools = orderedWindows(usage).map((pool) => ({
                    kind: pool.kind,
                    label: usageWindowLabel(pool),
                    percent: Math.round(pool.utilization),
                    resetsAt: pool.resetsAt,
                }));
                return [{ provider, account, usage, percent, pools, stale: isStale(usage) }];
            }),
        )
        // Tightest first: the account about to gate a turn is the one worth seeing without scrolling.
        .toSorted((left, right) => right.percent - left.percent),
);

// ---- the table and the export -------------------------------------------------------------------------------

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
    <div class="flex flex-col gap-6">
        <p v-if="error !== undefined" :class="cmp.alertDanger()">{{ error }}</p>

        <!-- ONE filter row, above everything, scoping everything below it. Date first: it is the control every
             reader reaches for. -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented v-model="preset" :options="RANGE_PRESETS" />
            <span class="h-4 w-px bg-line" />
            <Segmented v-model="providerFilter" :options="providerOptions" size="xs" />
            <button
                v-if="agentFilter !== undefined"
                type="button"
                class="flex cursor-pointer items-center gap-1 rounded-full bg-overlay px-2 py-0.5 text-2xs text-muted hover:text-content"
                @click="clearAgentFilter"
            >
                <Icon name="sliders-h" />{{ agentTitle(agentFilter) }}<Icon name="times" />
            </button>
            <button
                type="button"
                class="ml-auto flex cursor-pointer items-center gap-1 text-2xs text-muted hover:text-content"
                :disabled="isFetching"
                @click="() => void refetch()"
            >
                <Icon name="refresh" :class="isFetching ? `animate-spin` : ``" />Refresh
            </button>
        </div>

        <!-- A refetch holds the previous render at reduced opacity rather than swapping in skeletons: no
             layout jump, and the numbers you were reading stay readable while the new ones land. -->
        <div class="flex flex-col gap-6 transition-opacity" :class="isFetching && !isLoading ? `opacity-60` : ``">
            <p v-if="isLoading" :class="cmp.emptyState()">Reading the ledger…</p>

            <p v-else-if="rows.length === 0" :class="cmp.emptyState(`py-8`)">
                No turns have been billed on this sandbox yet. Spend is recorded at the end of every turn — run an agent and this fills in.
            </p>

            <template v-else>
                <!-- The hero and its supporting tiles. Spend is the one number this screen is about, so it is
                     the only figure at hero size; the rest are stat tiles. -->
                <!-- Every figure is sized against ITS OWN tile (@container + cqi), not the viewport: the tiles
                     go four-up at exactly the width where a four-figure amount stops fitting at 48px, so a
                     viewport breakpoint is the wrong ruler and a fixed size is how "$36.62" ended up hanging
                     out of its card. The floor of each clamp is a size the widest value this tile can hold
                     still fits at. -->
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                        <p class="mt-auto pt-2 text-2xs text-subtle">
                            {{ formatCompact(totals.cacheReadTokens) }} of prompt input served from cache — the share you were not billed full rate
                            for.
                        </p>
                    </Card>
                </div>

                <!-- Plan limits. Its own section, and deliberately NOT phrased like the tiles above it: "$36
                     spent here" and "98% of my plan's week is gone" are different questions with different
                     subjects, and the tab used to invite reading the second as a share of the first.
                     Every pool gets its own meter — one row per window, never a single "usage" number — because
                     these are separate allowances that fill at different rates, and folding them is how a
                     screen ends up saying 1% about an account that is actually out of room. -->
                <section v-if="headroom.length > 0" id="accounts">
                    <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
                        <span :class="cmp.sectionLabel()">Plan limits</span>
                        <span class="text-2xs text-subtle">
                            your whole Claude plan, not this sandbox — every device on the account spends the same pools
                        </span>
                    </div>
                    <div class="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
                        <div v-for="entry in headroom" :key="entry.account.id" class="flex flex-col gap-2.5 px-4 py-3">
                            <div class="flex items-baseline gap-2">
                                <ProviderLogo :provider="entry.provider" class="shrink-0 self-center text-sm text-muted" />
                                <span class="min-w-0 truncate text-sm text-content">{{ entry.account.label }}</span>
                                <!-- Freshness belongs on the ACCOUNT, not on each meter: one read produced all
                                     of these, and it is the single caveat that governs every number below. -->
                                <span class="ml-auto shrink-0 text-2xs" :class="entry.stale ? `text-muted` : `text-subtle`">
                                    read {{ formatAge(entry.usage.measuredAt) }}
                                </span>
                            </div>

                            <div v-for="pool in entry.pools" :key="pool.kind" class="flex items-center gap-3">
                                <span class="w-40 shrink-0 truncate text-2xs text-muted">{{ pool.label }}</span>
                                <!-- A pool at 0% still draws a sliver: an empty track is indistinguishable from a
                                     pool this screen has no reading for, and those mean opposite things. -->
                                <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-content/10">
                                    <div
                                        class="h-full rounded-full bg-current"
                                        :class="usageTone(pool.percent)"
                                        :style="{ width: `${Math.max(pool.percent, 1)}%` }"
                                    />
                                </div>
                                <span class="w-12 shrink-0 text-right text-2xs tabular-nums" :class="usageTone(pool.percent)">
                                    {{ formatUtilization(pool.percent, entry.stale) }}
                                </span>
                                <span class="hidden w-32 shrink-0 truncate text-right text-2xs text-subtle sm:block">
                                    {{ pool.resetsAt === undefined ? `` : `resets ${formatReset(pool.resetsAt)}` }}
                                </span>
                            </div>
                        </div>
                    </div>
                    <!-- The honest caveat, spelled out rather than left to a "≥". A reading is taken when a turn
                         ENDS, so an idle sandbox's is as old as its last turn, and the pools keep draining
                         elsewhere the whole time — which is the entire distance between "1%" here and 98% in a
                         terminal on the same account. -->
                    <p class="mt-2 px-0.5 text-2xs text-subtle">
                        Read from your plan when a turn finishes, so it can only be a floor: usage never falls inside a window, and other clients on
                        this account spend the same pools without telling this sandbox. Run a turn to refresh it.
                    </p>
                </section>

                <p v-else :class="cmp.emptyState()">
                    No account has reported its plan limits yet. Claude publishes them when a turn finishes; other providers don't report limits.
                </p>

                <Card>
                    <div class="mb-3 flex items-baseline justify-between gap-3">
                        <h3 class="text-sm font-semibold text-content">Spend per {{ preset === `all` ? `period` : `day` }}</h3>
                        <span class="text-sm tabular-nums text-muted">{{ formatUsd(totals.costUsd) }}</span>
                    </div>
                    <UsageColumnChart v-if="hasSpend" :series="series" :providers="seriesProviders" />
                    <p v-else :class="cmp.emptyState()">Nothing was billed in this range.</p>
                </Card>

                <div class="grid gap-3 lg:grid-cols-2">
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">Cost by model</h3>
                        <UsageBarChart v-if="byModel.length > 0" :entries="byModel" />
                        <p v-else :class="cmp.emptyState()">Nothing was billed in this range.</p>
                    </Card>
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">Cost by agent</h3>
                        <UsageBarChart v-if="byAgent.length > 0" :entries="byAgent" />
                        <p v-else :class="cmp.emptyState()">Nothing was billed in this range.</p>
                    </Card>
                </div>

                <!-- Not a nice-to-have: it is how anyone reconciles a number they distrust, and it is what
                     discharges the palette's sub-3:1 fills. -->
                <Card>
                    <div class="flex items-center justify-between gap-3">
                        <button type="button" class="flex cursor-pointer items-center gap-1.5 text-sm text-content" @click="tableOpen = !tableOpen">
                            <Icon :name="tableOpen ? `chevron-down` : `chevron-right`" class="text-muted" />
                            Show table
                            <span class="text-2xs text-subtle">{{ tableRows.length }} rows · {{ formatCompact(totals.turns) }} turns</span>
                        </button>
                        <button
                            type="button"
                            class="flex cursor-pointer items-center gap-1 text-2xs text-link hover:underline"
                            :disabled="tableRows.length === 0"
                            @click="exportCsv"
                        >
                            <Icon name="download" />Export CSV
                        </button>
                    </div>

                    <div v-if="tableOpen" class="scrollbar-thin mt-3 overflow-x-auto">
                        <table class="w-full text-2xs">
                            <thead class="text-left text-subtle">
                                <tr class="border-b border-line">
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
                                    <td class="py-1.5 pr-3">
                                        <span class="flex items-center gap-1.5">
                                            <span class="size-2 shrink-0 rounded-[2px]" :style="{ background: seriesColor(row.provider) }" />
                                            {{ providerLabel(row.provider) }}
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
                            Showing the {{ TABLE_LIMIT }} most recent of {{ tableRows.length }} rows — export the CSV for all of them.
                        </p>
                    </div>
                </Card>
            </template>
        </div>
    </div>
</template>
