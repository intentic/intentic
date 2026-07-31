<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { Card, cmp, RowGroup, Segmented } from "@intentic-app/ui";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import { useAgents } from "../../composables/agents/useAgents";
import { relativeTime } from "../../composables/chat/catalog";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../composables/chat/conversation";
import { formatAge, formatReset, formatUtilization, planLimitRows, usageTone } from "../../composables/chat/usageStatus";
import { useSavings } from "../../composables/sandbox/useSavings";
import { useUsage } from "../../composables/sandbox/useUsage";
import { compositionOf } from "./savingsChart";
import SavingsArmsChart from "./SavingsArmsChart.vue";
import SavingsStackBar from "./SavingsStackBar.vue";
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
 * The Savings section answers a third: what the token-reduction settings were WORTH over the same window. It
 * lives here rather than beside its switches on the Agent tab because a saving without a period is a lifetime
 * number that only grows and can be compared to nothing — and the window, the refresh and the provenance rules
 * this tab is built around are exactly what it needs. The switches keep their own one-line readouts.
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

// ---- savings ------------------------------------------------------------------------------------------------

// Windowed daemon-side (unlike the spend rollup, which comes down whole) — the ledgers behind it hold a row per
// Bash command and a row per turn, so the browser slicing them itself would mean shipping both raw.
const { savings } = useSavings(window);
const composition = computed(() => (savings.value === undefined ? undefined : compositionOf(savings.value.input)));
// A section that would only say "nothing yet" is not shown at all — every other panel on this tab is about
// turns that ran, and an empty savings card on a sandbox that never enabled a cleaner is just furniture.
const hasSavings = computed(
    () => (savings.value?.input.commands ?? 0) > 0 || savings.value?.output !== undefined || savings.value?.context !== undefined,
);
// Under rtk the numbers cannot be windowed (its ledger reports no timestamps), so the section says which
// calendar it is really on instead of sitting silently under a 7-day filter that does not reach it.
const savingsPeriod = computed(() =>
    savings.value?.input.windowed === false ? `all time — rtk's ledger reports no dates` : preset.value === `all` ? `all time` : `this range`,
);

// ---- plan limits --------------------------------------------------------------------------------------------

// Every connection this sandbox holds — the provider's own accounts AND the translator's subscriptions — as one
// list of meters. The projection (which lists, which snapshot, what order) lives in usageStatus.ts with the rest
// of the headroom vocabulary, so this tab and the Agent tab's rings can't come to disagree about an account.
const headroom = computed(() => planLimitRows(providerAccounts.value, translatorAccounts.value));

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
                <!-- The hero and its supporting tiles. Spend is the one number this screen is about, so it is the
                     only figure at hero size; the rest are stat tiles.
                     Every figure is sized against ITS OWN tile (@container + cqi), not the viewport — the grid
                     goes four-up at exactly the width where a four-figure amount stops fitting at 48px, so a
                     viewport breakpoint measures the wrong thing and a fixed size is how "$36.62" came to hang
                     out of its card. Each clamp's floor is a size the widest value that tile can hold still fits
                     at, with `truncate` as the backstop for a locale that disagrees. `mt-auto` on the last line
                     of each tile settles the footers onto one baseline however tall the grid stretches them. -->
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
                <RowGroup
                    v-if="headroom.length > 0"
                    id="accounts"
                    label="Plan limits"
                    caption="your whole plan, not this sandbox — every device on the account spends the same pools"
                >
                    <div v-for="entry in headroom" :key="entry.id" class="flex flex-col gap-2.5 px-4 py-3">
                        <div class="flex items-baseline gap-2">
                            <ProviderLogo :provider="entry.provider" class="shrink-0 self-center text-sm text-muted" />
                            <span class="min-w-0 truncate text-sm text-content">{{ entry.label }}</span>
                            <!-- Freshness belongs on the ACCOUNT, not on each meter: one read produced all of
                                 these, and it is the single caveat that governs every number below it. -->
                            <span
                                v-if="entry.measuredAt !== undefined"
                                class="ml-auto shrink-0 text-2xs"
                                :class="entry.stale ? `text-muted` : `text-subtle`"
                            >
                                read {{ formatAge(entry.measuredAt) }}
                            </span>
                        </div>

                        <!-- An account with no meters says WHICH kind of nothing it is. A blank row reads as
                             "plenty of room", and for a plan that publishes no limits at all — or one nothing has
                             measured yet — that is the opposite of what is known about it. -->
                        <p v-if="entry.pools.length === 0" class="text-2xs text-subtle">
                            {{ entry.readable ? `No reading yet.` : `This plan publishes no limits — spend is all this sandbox can tell you.` }}
                        </p>

                        <!-- Narrow screens keep the reset instead of dropping it — "when does this reopen" is
                             the number a phone is pulled out for — by wrapping the meter onto its own full-width
                             line; from sm up everything sits on one line in fixed columns so rows align. -->
                        <div v-for="pool in entry.pools" :key="pool.kind" class="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap">
                            <span class="min-w-0 flex-1 truncate text-2xs text-muted sm:w-40 sm:flex-none">{{ pool.label }}</span>
                            <!-- A pool at 0% still draws a sliver: an empty track is indistinguishable from a
                                 pool this screen has no reading for, and those mean opposite things. -->
                            <div
                                class="order-last h-1.5 min-w-0 flex-1 basis-full overflow-hidden rounded-full bg-content/10 sm:order-none sm:basis-0"
                            >
                                <div
                                    class="h-full rounded-full bg-current"
                                    :class="usageTone(pool.percent)"
                                    :style="{ width: `${Math.max(pool.percent, 1)}%` }"
                                />
                            </div>
                            <span class="w-12 shrink-0 text-right text-2xs tabular-nums" :class="usageTone(pool.percent)">
                                {{ formatUtilization(pool.percent, entry.stale) }}
                            </span>
                            <span class="shrink-0 truncate text-right text-2xs text-subtle sm:w-32">
                                {{ pool.resetsAt === undefined ? `` : `resets ${formatReset(pool.resetsAt)}` }}
                            </span>
                        </div>
                    </div>

                    <!-- The caveat sits INSIDE the surface, as the last row: a footnote floating below the border
                         is read after the numbers it qualifies, if at all. Two readers, one caveat: Claude's pools
                         come off the turn that just ended, so an idle sandbox's reading is as old as its last turn,
                         and the routed subscriptions' are pulled on the daemon's own cadence. Either way the pools
                         keep draining elsewhere — which is the entire distance between "1%" here and 98% in a
                         terminal on the same account. -->
                    <p class="px-4 py-2.5 text-2xs text-subtle">
                        Read from your plan — Claude's when a turn finishes, ChatGPT's and Google's pulled in the background — so a number here can
                        only ever be a floor: usage never falls inside a window, and other clients on the account spend the same pools without telling
                        this sandbox.
                    </p>
                </RowGroup>

                <!-- An unread state is not an empty one: until the connection read lands, this says nothing rather
                     than claiming the sandbox has no accounts and taking it back a moment later. -->
                <p v-else :class="cmp.emptyState()">
                    {{
                        accountsLoaded
                            ? `No AI account is connected yet — connect one on the Agent tab and its plan limits appear here.`
                            : `Reading your connections…`
                    }}
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

                <!-- SAVINGS — what the token-reduction settings were worth. Separate cards, never one ranking
                     of all the mechanisms together: the first is measured (every command carries its own raw
                     baseline, so the numbers are exact), the two after it are experiments (a turn cannot be
                     re-run unsteered, or uninformed, so each needs a control group, an n and a margin). Bars
                     side by side would lend the experiments the first card's confidence. They are also
                     different units of value — a saved tool-output token is saved again on every later request
                     of the conversation, an output token is saved once but costs several times as much, and
                     pre-injection trades input tokens for turns — which is why no card totals into another. -->
                <div v-if="hasSavings" class="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
                    <Card class="flex flex-col">
                        <div class="mb-1 flex items-baseline justify-between gap-3">
                            <h3 class="text-sm font-semibold text-content">Tool output → assistant</h3>
                            <span class="text-sm tabular-nums text-success">{{ savings?.input.savedPct ?? 0 }}% saved</span>
                        </div>
                        <!-- Provenance on its own line, not trailing the numbers: this card once sat on a
                             ledger nothing was writing any more, and a frozen figure reads exactly like a live
                             one unless its source and its age are stated. -->
                        <p class="mb-3 text-2xs text-subtle">
                            {{ formatCompact(savings?.input.commands ?? 0) }} commands · {{ savingsPeriod }} · via
                            {{ savings?.input.source === `rtk` ? `rtk gain` : `the output filter` }}
                            <template v-if="savings?.input.updatedAt !== undefined"
                                >· last command {{ relativeTime(savings.input.updatedAt) }}</template
                            >
                        </p>

                        <SavingsStackBar v-if="composition !== undefined && composition.rawTokens > 0" :composition="composition" />
                        <p v-else :class="cmp.emptyState()">No shell output was cleaned in this range.</p>

                        <!-- The whole-pipeline counterfactual, and the only one on this card that isn't
                             sequential: the held-out commands were left raw at random, so this compares two
                             populations rather than attributing within one. -->
                        <p v-if="savings?.input.holdout.measuredSavedPct !== undefined" class="mt-3 border-t border-line pt-2.5 text-2xs text-muted">
                            Holdout control: {{ savings.input.holdout.heldOut }} of
                            {{ savings.input.holdout.heldOut + savings.input.holdout.cleaned }} commands left raw, putting the measured reduction at
                            <span class="tabular-nums text-content">{{ savings.input.holdout.measuredSavedPct }}%</span>.
                        </p>
                    </Card>

                    <Card class="flex flex-col">
                        <div class="mb-1 flex items-baseline justify-between gap-3">
                            <h3 class="text-sm font-semibold text-content">Assistant's own output</h3>
                            <span class="text-2xs text-subtle">terse steer · A/B</span>
                        </div>
                        <p class="mb-3 text-2xs text-subtle">
                            Mean output tokens per turn, steered against a random unsteered control — the only honest way to measure this, since a
                            turn can't be re-run to see what it would have said.
                        </p>

                        <SavingsArmsChart
                            v-if="savings?.output !== undefined"
                            :experiment="savings.output"
                            on-label="steer on"
                            off-label="steer off (control)"
                        />
                        <p v-else :class="cmp.emptyState()">
                            Not being measured. Turn on
                            <RouterLink :to="{ name: `sandbox`, params: { tab: `agent` } }" class="text-link hover:underline"
                                >Terse responses</RouterLink
                            >
                            and give it a turn holdout — without a control group there is nothing to compare the steered turns against.
                        </p>
                    </Card>

                    <!-- Pre-injected search context. Judged on COST, not tokens: it spends input tokens on
                         purpose to buy back the search turns the model would otherwise have paid for, so the
                         only number that can settle whether it was worth it is the one with both halves in it. -->
                    <Card class="flex flex-col">
                        <div class="mb-1 flex items-baseline justify-between gap-3">
                            <h3 class="text-sm font-semibold text-content">Search before the turn</h3>
                            <span class="text-2xs text-subtle">pre-injected context · A/B</span>
                        </div>
                        <p class="mb-3 text-2xs text-subtle">
                            Mean cost per turn when the daemon retrieves for the message up front, against a random control that starts cold — the
                            injected context costs input tokens, so the trade only shows up in money.
                        </p>

                        <SavingsArmsChart
                            v-if="savings?.context !== undefined"
                            :experiment="savings.context"
                            on-label="context injected"
                            off-label="cold start (control)"
                        />
                        <p v-else :class="cmp.emptyState()">
                            Not being measured. Turn on
                            <RouterLink :to="{ name: `sandbox`, params: { tab: `agent` } }" class="text-link hover:underline"
                                >Retrieve before the turn</RouterLink
                            >
                            and give it a turn holdout — without a control group there is nothing to compare the retrieved turns against.
                        </p>
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
