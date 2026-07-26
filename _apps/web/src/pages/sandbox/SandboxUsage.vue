<script setup lang="ts">
import { Card, cmp, ProgressRing, RowGroup, Segmented } from "@intentic-app/ui";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import { useAgents } from "../../composables/agents/useAgents";
import { providerAccounts } from "../../composables/chat/conversation";
import { formatAge, usageDetail, usagePercent, usageStatusByAccount, usageWindowLabel } from "../../composables/chat/usageStatus";
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

/* The Sandbox hub's "Usage" tab: what the agents have cost, what is eating it, and how close each account is
 * to its limit. Every figure here is a projection of ONE durable source — the daemon's never-pruned spend
 * ledger (usage/usage-store.ts) — so a total can't shrink as the sandbox gets busier, which is exactly what
 * the old activity-log aggregation did.
 *
 * Two things are deliberately NOT on the same plot. Cost and tokens have unrelated scales, so they are two
 * tiles, never one chart with two y-axes. And headroom is a separate section from spend: a limit and a cost
 * are different mental models, and stacking them invites reading "78%" as a budget. */

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

// ---- account headroom -------------------------------------------------------------------------------------

// Every connected account that has reported a usage window, across providers. Claude is the only provider whose
// stream reports one today, so this is short by construction — and an account that has never run a turn is
// absent rather than shown at a confident 0%.
const headroom = computed(() =>
    Object.entries(providerAccounts.value)
        .flatMap(([provider, accounts]) =>
            accounts.flatMap((account) => {
                const usage = usageStatusByAccount.value[account.id];
                const percent = usagePercent(usage);
                return usage === undefined || percent === undefined ? [] : [{ provider, account, usage, percent }];
            }),
        )
        // Fullest first: the account about to gate a turn is the one worth seeing without scrolling.
        .toSorted((left, right) => right.percent - left.percent),
);

// The meter's fill carries severity; the provider's own status wins over the raw number, because a provider
// that says "rejected" is out regardless of what its last utilization reading said.
const meterTone = (percent: number, status: string): string =>
    status === `rejected` || percent >= 90 ? `text-danger` : status === `allowed_warning` || percent >= 75 ? `text-warning` : `text-link`;

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
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Card>
                        <div class="text-xs text-muted">Spend</div>
                        <div class="mt-1 text-5xl font-semibold leading-none text-content">{{ formatUsd(totals.costUsd) }}</div>
                        <div class="mt-2 flex items-center gap-1.5 text-2xs" :class="deltaTone(spendDelta)">
                            <template v-if="formatDelta(spendDelta) !== undefined">
                                <span>{{ deltaArrow(spendDelta) }}{{ formatDelta(spendDelta) }}</span>
                                <span class="text-subtle">{{ comparedTo }}</span>
                            </template>
                            <span v-else class="text-subtle">{{ comparedTo === undefined ? `All time` : `No spend in the previous period` }}</span>
                        </div>
                    </Card>

                    <Card>
                        <div class="text-xs text-muted">Turns</div>
                        <div class="mt-1 text-2xl font-semibold leading-none text-content">{{ formatCompact(totals.turns) }}</div>
                        <div class="mt-1 text-2xs" :class="deltaTone(turnsDelta)">
                            {{ formatDelta(turnsDelta) === undefined ? `—` : `${deltaArrow(turnsDelta)}${formatDelta(turnsDelta)}` }}
                        </div>
                        <UsageSparkline :points="turnPoints" class="mt-2 text-subtle" />
                    </Card>

                    <Card>
                        <div class="text-xs text-muted">Tokens</div>
                        <div class="mt-1 text-2xl font-semibold leading-none text-content">{{ formatCompact(totalTokens(totals)) }}</div>
                        <div class="mt-1 text-2xs" :class="deltaTone(tokensDelta)">
                            {{ formatDelta(tokensDelta) === undefined ? `—` : `${deltaArrow(tokensDelta)}${formatDelta(tokensDelta)}` }}
                        </div>
                        <UsageSparkline :points="tokenPoints" class="mt-2 text-subtle" />
                    </Card>

                    <Card>
                        <div class="text-xs text-muted">Cache hit rate</div>
                        <div class="mt-1 text-2xl font-semibold leading-none text-content">{{ formatPercent(cacheHitRate(totals)) }}</div>
                        <p class="mt-1 text-2xs text-subtle">
                            {{ formatCompact(totals.cacheReadTokens) }} of prompt input served from cache — the share you were not billed full rate
                            for.
                        </p>
                    </Card>
                </div>

                <!-- Headroom: a ratio against a limit, so a meter — and its own section, because "78% of my
                     weekly window" and "$47 spent" are different questions. -->
                <RowGroup v-if="headroom.length > 0" id="accounts" label="Account headroom">
                    <div v-for="entry in headroom" :key="entry.account.id" class="flex items-center gap-3 px-4 py-3">
                        <ProviderLogo :provider="entry.provider" class="shrink-0 text-base text-muted" />
                        <div class="min-w-0 flex-1">
                            <div class="flex items-baseline justify-between gap-2">
                                <span class="truncate text-sm text-content">{{ entry.account.label }}</span>
                                <span class="shrink-0 text-2xs text-subtle">{{ usageWindowLabel(entry.usage.rateLimitType) }}</span>
                            </div>
                            <!-- The track is a faint step of the fill's own ramp, so state reads across the
                                 whole bar rather than only where it happens to stop. -->
                            <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-content/10">
                                <div
                                    class="h-full rounded-full bg-current"
                                    :class="meterTone(entry.percent, entry.usage.status)"
                                    :style="{ width: `${entry.percent}%` }"
                                />
                            </div>
                            <p class="mt-1 text-2xs text-subtle">measured {{ formatAge(entry.usage.measuredAt) }}</p>
                        </div>
                        <div
                            v-tooltip.top="usageDetail(entry.usage)"
                            class="flex shrink-0 items-center gap-1.5"
                            :class="meterTone(entry.percent, entry.usage.status)"
                        >
                            <ProgressRing :value="entry.percent" :size="16" />
                            <span class="text-xs tabular-nums">{{ entry.percent }}%</span>
                        </div>
                    </div>
                </RowGroup>

                <p v-else :class="cmp.emptyState()">
                    No account has reported a usage window yet. Claude publishes one on its first turn; other providers don't report limits.
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
