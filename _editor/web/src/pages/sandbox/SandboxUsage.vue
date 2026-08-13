<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { BarChart, Card, cmp, Notice, type NoticeModel, NoticeStack, Segmented } from "@intentic/ui";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAgents } from "../../composables/agents/useAgents";
import { relativeTime } from "../../composables/chat/catalog";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { useSavings } from "../../composables/sandbox/useSavings";
import { useUsage } from "../../composables/sandbox/useUsage";
import PlanLimitsPanel from "./PlanLimitsPanel.vue";
import { compositionOf, dilutionOf, verdictsOf } from "./savingsChart";
import SavingsArmsChart from "./SavingsArmsChart.vue";
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
const outline = useSandboxOutline(isLoading);
const usageNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read this sandbox's usage.`, detail: error.value },
);
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
// Which calendar these numbers are on, said next to them rather than left to the range picker above — a total
// under a 7-day filter and the same total over all time are the same digits with different meanings.
const savingsPeriod = computed(() => (preset.value === `all` ? `all time` : `this range`));

/* Both experiments' headlines come from one function, so "Measuring" and "Off" land in the same slot, at the
 * same size, as a delta would — see verdictsOf. It takes the undefined case itself, which is what lets these be
 * two plain computeds and the cards one shape.
 *
 * A LIST, because an experiment can be read more than one way: the retrieval reports the searches a turn ran
 * and the searches it ran before touching a file, off one coin flip. The first is the card's headline and the
 * rest stack under it — a second card would claim a second experiment, which there isn't. */
const outputVerdicts = computed(() => verdictsOf(savings.value?.output));
const contextVerdicts = computed(() => verdictsOf(savings.value?.context));
// How much of the assigned arm the retrieval actually reached — one sentence about the coin flip, so it sits
// under the readings rather than inside any of them.
const contextDilution = computed(() => (savings.value?.context === undefined ? `` : dilutionOf(savings.value.context)));

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
    <div class="@container flex flex-col gap-6">
        <Notice v-if="usageNotice" :of="usageNotice" />

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
            <!-- THE TILES AND THE CHART UNDER THEM, in their own grid at their own breakpoints. This tab's
                 layout is its most recognisable feature — one hero figure, three tiles, a column chart — and
                 the shape alone tells a returning reader they are in the right place while the ledger is still
                 being summed. The figures are deliberately NOT stood in for at their real size: a big grey bar
                 where a number goes reads as a number that failed to load. -->
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

            <!-- `!isLoading`, not just "the outline isn't up": a ledger still being read has not yet earned the
                 right to tell anyone they have never run an agent. -->
            <p v-else-if="!isLoading && rows.length === 0" :class="cmp.emptyState(`py-8`)">
                No turns have been billed on this sandbox yet. Spend is recorded at the end of every turn — run an agent and this fills in.
            </p>

            <template v-else-if="!isLoading">
                <!-- The hero and its supporting tiles. Spend is the one number this screen is about, so it is the
                     only figure at hero size; the rest are stat tiles.
                     Every figure is sized against ITS OWN tile (@container + cqi), not the viewport — the grid
                     goes four-up at exactly the width where a four-figure amount stops fitting at 48px, so a
                     viewport breakpoint measures the wrong thing and a fixed size is how "$36.62" came to hang
                     out of its card. Each clamp's floor is a size the widest value that tile can hold still fits
                     at, with `truncate` as the backstop for a locale that disagrees. `mt-auto` on the last line
                     of each tile settles the footers onto one baseline however tall the grid stretches them. -->
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
                        <p class="mt-auto pt-2 text-2xs text-subtle">
                            {{ formatCompact(totals.cacheReadTokens) }} of prompt input served from cache — the share you were not billed full rate
                            for.
                        </p>
                    </Card>
                </div>

                <!-- Plan limits. Its own section, and deliberately NOT phrased like the tiles above it: "$36
                     spent here" and "98% of my plan's week is gone" are different questions with different
                     subjects, and the tab used to invite reading the second as a share of the first. Its whole
                     hierarchy lives in the panel — this tab only says where it goes. -->
                <PlanLimitsPanel />

                <Card>
                    <div class="mb-3 flex items-baseline justify-between gap-3">
                        <h3 class="text-sm font-semibold text-content">Spend per {{ preset === `all` ? `period` : `day` }}</h3>
                        <span class="text-sm tabular-nums text-muted">{{ formatUsd(totals.costUsd) }}</span>
                    </div>
                    <UsageColumnChart v-if="hasSpend" :series="series" :providers="seriesProviders" />
                    <p v-else :class="cmp.emptyState()">Nothing was billed in this range.</p>
                </Card>

                <div class="grid gap-3 @2xl:grid-cols-2">
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">Cost by model</h3>
                        <BarChart v-if="byModel.length > 0" :items="rankedBars(byModel)" :label-width="8" />
                        <p v-else :class="cmp.emptyState()">Nothing was billed in this range.</p>
                    </Card>
                    <Card>
                        <h3 class="mb-3 text-sm font-semibold text-content">Cost by agent</h3>
                        <BarChart v-if="byAgent.length > 0" :items="rankedBars(byAgent)" :label-width="8" />
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
                     pre-injection trades input tokens for turns — which is why no card totals into another.

                     Different subjects, but ONE shape: title, verdict, evidence, provenance, in that order and
                     those positions (SavingsCard). The cards used to be written independently and had drifted
                     into three different ones — only the first led with a number, and the other two opened with
                     a paragraph of method where their answer should have been — so the row could not be scanned
                     and every card had to be read to learn whether it said anything at all. The method text is
                     not gone; it moved behind each title's (i), which is the altitude it belongs at.

                     A CONTAINER grid, not a viewport one. This section sits behind the rail, the chat panel and
                     the tab's padding, so `xl:grid-cols-3` was asking the window a question only the card knows
                     the answer to — and getting 215px cards on a 1280px screen, at which width every label in
                     them truncated. The breakpoints below are the widths where three, then two, cards still
                     clear ~330px. Same reasoning as the stat tiles' cqi type, one level up. -->
                <section v-if="hasSavings" class="@container">
                    <div class="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5">
                        <span :class="cmp.sectionLabel()">Token savings</span>
                        <span class="min-w-0 text-2xs text-subtle">what the token-reduction settings were worth</span>
                    </div>

                    <!-- items-start: a card with nothing to report stays short instead of being stretched to the
                         tallest one's height and padded with the void that made this row look broken.
                         Two columns ⇒ the composition card takes both rows of the left one and the two
                         experiments stack beside it. They are the same shape as each other and roughly half its
                         height, so the alternative — plain flow — parks the third card under the first and
                         leaves a card-sized hole where the second one ended. -->
                    <div class="grid items-start gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
                        <SavingsCard
                            class="@2xl:row-span-2 @5xl:row-auto"
                            title="Tool output → assistant"
                            :value="`${savings?.input.savedPct ?? 0}%`"
                            unit="of shell output removed"
                            tone="success"
                        >
                            <template #hint>
                                Every command carries its own raw baseline, so this is realized, not estimated. Each stage is weighed against what
                                reached it — sequential attribution, which is what makes the parts sum to the whole and lets them be stacked at all.
                                It is not "what turning this cleaner off would cost you": the cap downstream would have eaten some of the same lines.
                                The retrieval footers are the price of the trimming being reversible — the pointers that let the agent grep the full
                                output back.
                            </template>

                            <SavingsStackBar v-if="composition !== undefined && composition.rawTokens > 0" :composition="composition" />
                            <p v-else :class="cmp.emptyState()">No shell output was cleaned in this range.</p>

                            <!-- The whole-pipeline counterfactual, and the only one on this card that isn't
                                 sequential: the held-out commands were left raw at random, so this compares two
                                 populations rather than attributing within one. One line, because it is a
                                 second reading of the headline rather than a second subject. -->
                            <p v-if="savings?.input.holdout.measuredSavedPct !== undefined" class="border-t border-line pt-2 text-2xs text-muted">
                                Holdout control
                                <span class="tabular-nums text-content">{{ savings.input.holdout.measuredSavedPct }}%</span> — measured against
                                {{ savings.input.holdout.heldOut }} of {{ savings.input.holdout.heldOut + savings.input.holdout.cleaned }} commands
                                left raw at random.
                            </p>

                            <!-- Provenance, never trailing the numbers: this card once sat on a ledger nothing
                                 was writing any more, and a frozen figure reads exactly like a live one unless
                                 its age is stated. -->
                            <template #footnote>
                                {{ formatCompact(savings?.input.commands ?? 0) }} commands · {{ savingsPeriod }}
                                <template v-if="savings?.input.updatedAt !== undefined"
                                    >· last command {{ relativeTime(savings.input.updatedAt) }}</template
                                >
                            </template>
                        </SavingsCard>

                        <SavingsCard
                            title="Assistant's own output"
                            :value="outputVerdicts.headline.value"
                            :unit="outputVerdicts.headline.unit"
                            :tone="outputVerdicts.headline.tone"
                        >
                            <template #hint>
                                Mean prose written per turn with the terse steer appended, against a random unsteered control — the only honest way to
                                measure it, since a turn can't be re-run to see what it would have said. Only turns the steer was eligible for count:
                                a turn under a custom system prompt drops it along with everything else the daemon appends.
                            </template>

                            <SavingsArmsChart
                                v-if="savings?.output !== undefined"
                                :reading="savings.output.metrics[0]"
                                :detail="outputVerdicts.headline.detail"
                                on-label="steer on"
                                off-label="steer off · control"
                            />
                            <template v-else>
                                <p class="text-xs text-muted">
                                    Needs the switch on and a turn holdout set — with no control arm there is nothing to compare against.
                                </p>
                                <!-- The category holding the switch, named: the Agent tab shows one group of
                                     settings at a time, so a link that only names the tab lands somewhere this
                                     row's own switch isn't. -->
                                <RouterLink
                                    :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `instructions` } }"
                                    class="flex items-center gap-1 self-start text-xs text-link hover:underline"
                                >
                                    Terse responses<Icon name="chevron-right" />
                                </RouterLink>
                            </template>

                            <template #footnote>terse steer · A/B against a random holdout</template>
                        </SavingsCard>

                        <!-- Pre-injected search context. Judged on SEARCHES — the thing it removes — after cost
                             per turn spent nine days measuring which arm had drawn the bigger jobs. Two readings
                             off one coin flip, so they share a card: the headline counts every search a turn
                             ran, the line under the bars counts only the ones before it opened a file. -->
                        <SavingsCard
                            title="Search before the turn"
                            :value="contextVerdicts.headline.value"
                            :unit="contextVerdicts.headline.unit"
                            :tone="contextVerdicts.headline.tone"
                        >
                            <template #hint>
                                Mean searches per turn when the daemon retrieves for the message up front, against a random control that starts cold.
                                Scored in searches on purpose: the retrieval hands over the anchors a turn would otherwise go and find, so searches
                                are the thing it moves. Cost per turn cannot see it — a turn's price is dominated by how big the job was, and the coin
                                flip does not deal both arms the same jobs.
                            </template>

                            <SavingsArmsChart
                                v-if="savings?.context !== undefined"
                                :reading="savings.context.metrics[0]"
                                :detail="contextVerdicts.headline.detail"
                                on-label="context injected"
                                off-label="cold start · control"
                            />
                            <!-- The narrower reading, as a line rather than a second pair of bars: it is the same
                                 turns counted differently, and drawing it again at full size would read as a
                                 second experiment agreeing with the first. -->
                            <p v-for="verdict in contextVerdicts.also" :key="verdict.unit" class="text-2xs text-subtle">
                                <span class="tabular-nums" :class="verdict.tone === `success` ? `text-success` : `text-muted`">{{
                                    verdict.value
                                }}</span>
                                {{ verdict.unit }} · {{ verdict.detail }}
                            </p>
                            <!-- Said once, under every reading, because it qualifies all of them: the arm is the
                                 coin flip's, and most of it may never have been treated at all. -->
                            <p v-if="contextDilution !== ``" class="text-2xs text-subtle">{{ contextDilution }}</p>
                            <template v-else>
                                <p class="text-xs text-muted">
                                    Needs the switch on and a turn holdout set — with no control arm there is nothing to compare against.
                                </p>
                                <RouterLink
                                    :to="{ name: `sandbox`, params: { tab: `agent` }, query: { section: `running` } }"
                                    class="flex items-center gap-1 self-start text-xs text-link hover:underline"
                                >
                                    Retrieve before the turn<Icon name="chevron-right" />
                                </RouterLink>
                            </template>

                            <template #footnote>pre-injected context · A/B against a random holdout</template>
                        </SavingsCard>
                    </div>
                </section>

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
                                            <span class="size-2 shrink-0 rounded-[2px]" :style="{ background: providerColor(row.provider) }" />
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
