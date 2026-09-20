<script setup lang="ts">
import { BarChart, Card, ui, Notice, type NoticeModel, NoticeStack, SegmentedControl, vAction } from "@intentic/ui";
import { localZone, sameClock, UTC } from "@intentic/sandbox-contract/time";
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
    rangePresets,
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
import { useT } from "@intentic/ui/i18n";

// The Usage tab answers three separate questions, kept visually distinct:
//   - what has this sandbox cost (the never-pruned spend ledger, scoped by the filter row)
//   - how much of your plan is left (account-wide, provider-reported, unaffected by the filters, no dollar figure)
//   - what the token-reduction settings were worth over this window (its own section, needs a period to mean anything)
// Cost and tokens stay separate tiles, never one chart with two y-axes: unrelated scales.

const t = useT();

const route = useRoute();
const router = useRouter();
const { rows, isLoading, isFetching, refetch, error } = useUsage();
const outline = useSandboxOutline(isLoading);
const usageNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.sandboxUsage.couldntReadSandboxsUsage`), detail: error.value },
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
// Whether this reader's own midnight is UTC's. For them the label below would be noise; for everyone else it is the
// difference between "today" meaning what they think and it quietly meaning a window they never chose.
const dayBoundaryDiffers = computed(() => !sameClock(UTC, localZone()));
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
    { label: t(`sandbox.sandboxUsage.allProviders`), value: `all` },
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
    preset.value === `all`
        ? undefined
        : `vs previous ${
              rangePresets()
                  .find((entry) => entry.value === preset.value)
                  ?.label.toLowerCase() ?? ``
          }`,
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

        <div class="flex items-center gap-3 rounded-xl border border-line-subtle bg-card px-4 py-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-600/10 text-link" aria-hidden="true">
                <Icon name="usage" class="text-xl" />
            </span>
            <div class="min-w-0">
                <p class="text-xs font-medium leading-relaxed text-content">{{ t(`sandbox.sandboxUsage.noIntenticCharge`) }}</p>
                <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ t(`sandbox.sandboxUsage.apiPricingBasis`) }}</p>
            </div>
        </div>

        <!-- One filter row scoping everything below; date first, the control every reader reaches for. -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SegmentedControl v-model="preset" :options="rangePresets()" />
            <!-- These days are UTC days, at both ends: the daemon stamps every row in UTC so that last month's totals
                 cannot change when somebody moves a setting. Said out loud only to a reader whose own midnight is a
                 different moment, for whom "today" here is not the today they mean. -->
            <span v-if="dayBoundaryDiffers" class="text-2xs text-subtle" :title="t(`sandbox.sandboxUsage.daysRunMidnight`)">
                {{ t(`sandbox.sandboxUsage.utcDays`) }}
            </span>
            <span class="h-4 w-px bg-line" />
            <SegmentedControl v-model="providerFilter" :options="providerOptions" size="xs" />
            <button v-if="agentFilter !== undefined" type="button" class="ui-chip gap-1" @click="clearAgentFilter">
                <Icon name="sliders-h" />{{ agentTitle(agentFilter) }}<Icon name="times" />
            </button>
            <button
                type="button"
                :class="ui.iconButton('ml-auto')"
                :aria-label="t(`ui.action.refresh`)"
                v-tooltip.top="t(`ui.action.refresh`)"
                :disabled="isFetching"
                v-action="() => refetch()"
            >
                <Icon name="refresh" class="text-sm" :spin="isFetching" />
            </button>
        </div>

        <!-- Refetch dims the previous render instead of swapping in skeletons: no layout jump, numbers stay readable. -->
        <div class="flex flex-col gap-6 transition-opacity" :class="isFetching && !isLoading ? `opacity-60` : ``">
            <!-- Skeleton mirrors the real layout (hero, tiles, chart) so a returning reader recognises it while the ledger sums. -->
            <div v-if="isLoading && outline" role="status" aria-busy="true" class="flex flex-col gap-6">
                <span class="sr-only">{{ t(`sandbox.sandboxUsage.readingLedger`) }}</span>
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
                    <!-- Uneven column heights preserve the chart's data shape. -->
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
                {{ t(`sandbox.sandboxUsage.noUsageYet`) }}
            </p>

            <template v-else-if="!isLoading">
                <!-- Spend alone is hero-sized, the rest are stat tiles. -->
                <div class="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-4">
                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">{{ t(`sandbox.sandboxUsage.spend`) }}</div>
                        <div class="mt-1 truncate text-[clamp(1.5rem,13cqi,3rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatUsdHero(totals.costUsd) }}
                        </div>
                        <div class="mt-auto flex flex-wrap items-baseline gap-x-1.5 pt-2 text-2xs" :class="deltaTone(spendDelta)">
                            <template v-if="formatDelta(spendDelta) !== undefined">
                                <span class="tabular-nums">{{ deltaArrow(spendDelta) }}{{ formatDelta(spendDelta) }}</span>
                                <span class="text-subtle">{{ comparedTo }}</span>
                            </template>
                            <span v-else class="text-subtle">{{
                                comparedTo === undefined ? t(`sandbox.sandboxUsage.allTime`) : t(`sandbox.sandboxUsage.noSpendInPrevious`)
                            }}</span>
                        </div>
                    </Card>

                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">{{ t(`sandbox.sandboxUsage.turns`) }}</div>
                        <div class="mt-1 truncate text-[clamp(1.25rem,9cqi,1.75rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatCompact(totals.turns) }}
                        </div>
                        <div class="mt-1 text-2xs tabular-nums" :class="deltaTone(turnsDelta)">
                            {{ formatDelta(turnsDelta) === undefined ? `—` : `${deltaArrow(turnsDelta)}${formatDelta(turnsDelta)}` }}
                        </div>
                        <UsageSparkline :points="turnPoints" class="mt-auto pt-2 text-subtle" />
                    </Card>

                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">{{ t(`sandbox.sandboxUsage.tokens`) }}</div>
                        <div class="mt-1 truncate text-[clamp(1.25rem,9cqi,1.75rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatCompact(totalTokens(totals)) }}
                        </div>
                        <div class="mt-1 text-2xs tabular-nums" :class="deltaTone(tokensDelta)">
                            {{ formatDelta(tokensDelta) === undefined ? `—` : `${deltaArrow(tokensDelta)}${formatDelta(tokensDelta)}` }}
                        </div>
                        <UsageSparkline :points="tokenPoints" class="mt-auto pt-2 text-subtle" />
                    </Card>

                    <Card class="@container flex min-w-0 flex-col">
                        <div class="text-xs text-muted">{{ t(`sandbox.sandboxUsage.cacheHitRate`) }}</div>
                        <div class="mt-1 truncate text-[clamp(1.25rem,9cqi,1.75rem)] font-semibold leading-none tabular-nums text-content">
                            {{ formatPercent(cacheHitRate(totals)) }}
                        </div>
                        <p class="mt-auto pt-2 text-2xs text-subtle">
                            {{ t(`sandbox.sandboxUsage.promptInputCached`, { cacheReadTokens: formatCompact(totals.cacheReadTokens) }) }}
                        </p>
                    </Card>
                </div>

                <!-- Its own section, not phrased like the tiles above: spend and plan-week-remaining are different questions. -->
                <PlanLimitsPanel />

                <Card>
                    <div class="mb-3 flex items-baseline justify-between gap-3">
                        <h3 class="text-sm font-semibold text-content">
                            {{ preset === `all` ? t(`sandbox.sandboxUsage.spendPerPeriod`) : t(`sandbox.sandboxUsage.spendPerDay`) }}
                        </h3>
                        <span class="text-sm tabular-nums text-muted">{{ formatUsd(totals.costUsd) }}</span>
                    </div>
                    <UsageColumnChart v-if="hasSpend" :series="series" :providers="seriesProviders" />
                    <p v-else :class="ui.emptyState()">{{ t(`sandbox.sandboxUsage.noUsageInRange`) }}</p>
                </Card>

                <div class="grid gap-3 @2xl:grid-cols-2">
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">{{ t(`sandbox.sandboxUsage.costByModel`) }}</h3>
                        <BarChart v-if="byModel.length > 0" :items="rankedBars(byModel)" :label-width="8" />
                        <p v-else :class="ui.emptyState()">{{ t(`sandbox.sandboxUsage.noUsageInRange`) }}</p>
                    </Card>
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">{{ t(`sandbox.sandboxUsage.costByAgent`) }}</h3>
                        <BarChart v-if="byAgent.length > 0" :items="rankedBars(byAgent)" :label-width="8" />
                        <p v-else :class="ui.emptyState()">{{ t(`sandbox.sandboxUsage.noUsageInRange`) }}</p>
                    </Card>
                </div>

                <!-- Keep measured usage separate from the experimental comparison. -->
                <section v-if="hasSavings" class="@container">
                    <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
                        <span :class="ui.sectionLabel()">{{ t(`sandbox.sandboxUsage.tokenSavings`) }}</span>
                    </div>

                    <!-- `items-start`: a short card stays short, not stretched to the tallest. -->
                    <div class="grid items-start gap-3 @2xl:grid-cols-2">
                        <SavingsCard
                            :title="t(`sandbox.sandboxUsage.toolOutputAssistant`)"
                            :value="`${savings?.input.savedPct ?? 0}%`"
                            unit="of shell output removed"
                            tone="success"
                        >
                            <template #hint>
                                {{ t(`sandbox.sandboxUsage.everyCommandCarriesOwn`) }}
                            </template>

                            <SavingsStackBar v-if="composition !== undefined && composition.rawTokens > 0" :composition="composition" />
                            <p v-else :class="ui.emptyState()">{{ t(`sandbox.sandboxUsage.noShellOutputCleaned`) }}</p>

                            <!-- This comparison measures the whole pipeline, including raw commands. -->
                            <p v-if="savings?.input.holdout.measuredSavedPct !== undefined" class="mt-2 text-2xs text-muted">
                                {{ t(`sandbox.sandboxUsage.holdoutControl`) }}
                                <span class="tabular-nums text-content">{{ savings.input.holdout.measuredSavedPct }}%</span
                                >{{ t(`sandbox.sandboxUsage.measuredAgainst`) }} {{ savings.input.holdout.heldOut }}
                                {{ t(`sandbox.sandboxUsage.of`) }} {{ savings.input.holdout.heldOut + savings.input.holdout.cleaned }}
                                {{ t(`sandbox.sandboxUsage.commandsLeftRawAt`) }}
                            </p>

                            <!-- Age stated always: a frozen figure reads exactly like a live one otherwise. -->
                            <template #footnote>
                                {{ formatCompact(savings?.input.commands ?? 0) }} {{ t(`sandbox.sandboxUsage.commands`) }} {{ savingsPeriod }}
                                <template v-if="savings?.input.updatedAt !== undefined">{{
                                    t(`sandbox.sandboxUsage.lastCommand`, { updatedAt: relativeTime(savings.input.updatedAt) })
                                }}</template>
                            </template>
                        </SavingsCard>
                    </div>
                </section>

                <!-- How a distrusted number gets reconciled, and what discharges the palette's low-contrast fills. -->
                <Card>
                    <div class="flex items-center justify-between gap-3">
                        <button type="button" class="flex cursor-pointer items-center gap-1.5 text-sm text-content" @click="tableOpen = !tableOpen">
                            <Icon :name="tableOpen ? `chevron-down` : `chevron-right`" class="text-muted" />
                            {{ t(`sandbox.sandboxUsage.showTable`) }}
                            <span class="text-2xs text-subtle">{{
                                t(`sandbox.sandboxUsage.rowsTurns`, { count: tableRows.length, turns: formatCompact(totals.turns) })
                            }}</span>
                        </button>
                        <button type="button" :class="ui.linkButton(`gap-1 text-2xs`)" :disabled="tableRows.length === 0" @click="exportCsv">
                            <Icon name="download" />{{ t(`sandbox.sandboxUsage.exportCsv`) }}
                        </button>
                    </div>

                    <div v-if="tableOpen" class="mt-3 overflow-x-auto">
                        <table class="w-full text-2xs">
                            <thead class="text-left text-subtle">
                                <tr class="border-b border-line-subtle">
                                    <th class="py-1.5 pr-3 font-medium">{{ t(`sandbox.sandboxUsage.day`) }}</th>
                                    <th class="py-1.5 pr-3 font-medium">{{ t(`sandbox.sandboxUsage.provider`) }}</th>
                                    <th class="py-1.5 pr-3 font-medium">{{ t(`sandbox.sandboxUsage.model`) }}</th>
                                    <th class="py-1.5 pr-3 font-medium">{{ t(`sandbox.sandboxUsage.agent`) }}</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">{{ t(`sandbox.sandboxUsage.turns`) }}</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">{{ t(`sandbox.sandboxUsage.in`) }}</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">{{ t(`sandbox.sandboxUsage.out`) }}</th>
                                    <th class="py-1.5 pr-3 text-right font-medium">{{ t(`sandbox.sandboxUsage.cached`) }}</th>
                                    <th class="py-1.5 text-right font-medium">{{ t(`sandbox.sandboxUsage.cost`) }}</th>
                                </tr>
                            </thead>
                            <tbody class="tabular-nums text-muted">
                                <tr v-for="(row, index) in tableRows.slice(0, TABLE_LIMIT)" :key="index" class="border-b border-line/50">
                                    <td class="py-1.5 pr-3 whitespace-nowrap">{{ row.day }}</td>
                                    <!-- Swatches identify chart series; names identify billing cards. -->
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
                                        {{ row.conversationId === undefined ? t(`sandbox.sandboxUsage.mainTree`) : agentTitle(row.conversationId) }}
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
                            {{ t(`sandbox.sandboxUsage.showingMostRecentRows`, { table_limit: TABLE_LIMIT, count: tableRows.length }) }}
                        </p>
                    </div>
                </Card>
            </template>
        </div>
    </div>
</template>
