<script setup lang="ts">
import { type AccountFix, providerLabel } from "@intentic/sandbox-contract";
import { Card, SearchBar, SkeletonSnapshot, type Tip, ui, vSkeletonSource } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../chat/accounts/providerAccounts";
import { refreshConnections } from "../../chat/accounts/useChat-accounts";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import {
    accountFixLabel,
    formatAge,
    formatRemaining,
    formatReset,
    meterFill,
    meterTint,
    meterTrack,
    nestPools,
    type PlanLimitBand,
    PLAN_LIMIT_BANDS,
    type PlanLimitAttention,
    type PlanLimitGroup,
    planLimitBandLabel,
    planLimitBandTint,
    planLimitBandTone,
    planLimitGroups,
    type PlanLimitRow,
    planLimitRows,
    planLimitSummary,
    remainingFigure,
    usageTone,
} from "../../chat/session/usageStatus";
import { useT } from "@intentic/ui/i18n";

// How much of your plans is left, the section that must scale to a 36-connection fleet rather than one row per
// account. A hierarchy, each level answering a different question:
//   1. CAPACITY: can I start work? Counts by band (never a mean of many pools), plus the soonest reopen.
//   2. PROVIDERS: where do I run? The provider is the unit, since the translator picks the account, not the user.
//      Small providers show inline meters; large ones show a distribution and a roster link.
//   3. ATTENTION: what's broken (unrefreshable), narrower than "unavailable": a spent pool reopens on its own
//      and is already counted at level 1.
//   4. ROSTER: a filterable table to reconcile one account.
// Laid out as cards: one per provider down the left, and the fleet-wide answers (1 and 3) in one card spanning their
// full height on the right, so "can I start work" stays beside whichever provider is being read. Narrow, that card
// stacks above them. The roster runs under both, since a table needs the width.
// Distribution uses bar height, not colour-only cells: this system's severity ramp (orange/amber/red) is
// unreadable as colour alone to a red-weak reader.

// Refreshes on arrival since plan pools are account-wide (other clients spend the same allowance), so a stale
// read looks confidently wrong. Same pattern as the account rows' rings in Sandbox ▸ Models (models/ProviderAccounts.vue).
const t = useT();

onMounted(() => void refreshConnections());

// Module-level flag, not a query, but gated the same way: nothing draws for a read landing in the first beat.
const outline = useSandboxOutline(computed(() => !accountsLoaded.value));

const rows = computed(() => planLimitRows(providerAccounts.value, translatorAccounts.value));
const groups = computed(() => planLimitGroups(rows.value));
const summary = computed(() => planLimitSummary(rows.value));

// capacity

// Excludes the two bands that aren't degrees of fullness — a plan that publishes no limits, and a credential no turn
// can run on — since counting either as capacity is what lets a fleet of dead accounts read as a fuller one.
const OFF_BAR_BANDS: ReadonlySet<PlanLimitBand> = new Set([`none`, `blocked`]);
const CAPACITY_BANDS = PLAN_LIMIT_BANDS.filter((band) => !OFF_BAR_BANDS.has(band));
const capacityTotal = computed(() => CAPACITY_BANDS.reduce((sum, band) => sum + summary.value.counts[band], 0));
const capacity = computed(() =>
    CAPACITY_BANDS.filter((band) => summary.value.counts[band] > 0).map((band) => ({
        band,
        count: summary.value.counts[band],
        label: planLimitBandLabel(band),
        share: (100 * summary.value.counts[band]) / Math.max(1, capacityTotal.value),
    })),
);

// The one grid both the panel and its skeleton stand on: provider cards on the left, the fleet-wide card on the right
// once the panel is wide enough for both. One string, so the outline cannot promise a column the panel never draws.
const SPLIT = `grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_16rem] @4xl:grid-cols-[minmax(0,1fr)_18rem]`;

// groups

// Up to 3 accounts render inline; folding what already fits hides it for no gain.
const INLINE_LIMIT = 3;
const isInline = (group: PlanLimitGroup): boolean => group.rows.length <= INLINE_LIMIT;
// A single-account provider has no list to head; the group row is that account's row.
const single = (group: PlanLimitGroup): PlanLimitRow | undefined => (group.rows.length === 1 ? group.rows[0] : undefined);

// Names the lone account (with identity if needed); multi-account groups rely on stripes or inline meters instead.
const groupNote = (group: PlanLimitGroup): string | undefined => {
    const account = single(group);
    if (account === undefined) {
        return undefined;
    }
    return account.identity === undefined ? account.label : `${account.label} · ${account.identity}`;
};

// Caps the strip (past this, bars are hairlines); tightest-first order keeps what matters when truncated.
const MAX_BARS = 24;
const barsOf = (group: PlanLimitGroup): readonly PlanLimitRow[] => group.rows.slice(0, MAX_BARS);

// What a folded group states instead of an aggregate: its tightest account, or which kind of nothing
// (unread/no limits). Inline groups say nothing here, their meters are already visible below.
const groupState = (group: PlanLimitGroup): string => {
    if (group.tightest?.percent !== undefined) {
        return t(`sandbox.planLimitsPanel.tightest`, { remaining: formatRemaining(group.tightest.percent, group.tightest.stale), label: group.tightest.label });
    }
    if (group.counts.none === group.rows.length) {
        return t(`sandbox.planLimitsPanel.publishesNoLimits`);
    }
    if (group.counts.unread > 0) {
        return t(`sandbox.planLimitsPanel.unread`);
    }
    return ``;
};

// An account's pools as a tree: the 5-hour session drawn under the week it spends into, not beside it as a peer.
const nestedPools = (row: PlanLimitRow) => nestPools(row.pools, (pool) => pool);

const barTooltip = (row: PlanLimitRow): string =>
    row.percent === undefined
        ? `${row.label} · ${t(`sandbox.planLimitsPanel.noReadingYetLower`)}`
        : `${row.label} · ${row.binding?.label ?? ``} ${formatRemaining(row.percent, row.stale)}${
              row.binding?.resetsAt === undefined ? `` : ` · ${t(`sandbox.planLimitsPanel.resets`, { resetsAt: formatReset(row.binding.resetsAt) })}`
          }`;

// attention

// One held-back name's hover: who it signs in as, and the provider's own reason for holding it, verbatim.
const attentionTip = (row: PlanLimitAttention[`rows`][number]): Tip => ({
    title: row.label,
    rows: [
        { label: t(`sandbox.planLimitsPanel.account`), value: row.identity ?? `` },
        { label: t(`sandbox.planLimitsPanel.reason`), value: row.state.reason },
    ],
});

// Caps a fleet-wide expiry (real: a slept laptop, a mass revoke) from reverting this to a long column. Per condition,
// so thirty expired sign-ins can't push the two accounts missing something else off the panel.
const ATTENTION_SHOWN = 12;
const attentionExpanded = ref(false);
const attentionTotal = computed(() => summary.value.attention.reduce((count, group) => count + group.rows.length, 0));
// Split by who can fix it (the verdict's `fix`): a lost seat is handed back by the organisation, a verification by the
// account's owner on the provider's page, the rest by signing in again.
const fixTotal = (fix: Exclude<AccountFix, `wait`>): number => summary.value.attention.find((group) => group.fix === fix)?.rows.length ?? 0;
const seatTotal = computed(() => fixTotal(`admin`));
const reconnectTotal = computed(() => fixTotal(`reconnect`));
const verifyTotal = computed(() => fixTotal(`verify`));
const attentionShown = computed(() =>
    summary.value.attention.map((group) => ({
        fix: group.fix,
        reason: accountFixLabel(group.fix),
        // The providers' own words, each once, under the fix's name: thirty expired sign-ins are one line, not thirty.
        detail: group.reasons.join(` · `),
        rows: attentionExpanded.value ? group.rows : group.rows.slice(0, ATTENTION_SHOWN),
        hidden: attentionExpanded.value ? 0 : Math.max(0, group.rows.length - ATTENTION_SHOWN),
    })),
);

// the roster

const rosterOpen = ref(false);
const rosterProvider = ref<string | undefined>(undefined);
const rosterQuery = ref(``);

// Opens the one roster table rather than a second inline copy; every drill-in path lands in the same place.
const openRoster = (provider: string): void => {
    rosterProvider.value = provider;
    rosterOpen.value = true;
};

const roster = computed(() => {
    const query = rosterQuery.value.trim().toLowerCase();
    return (
        rows.value
            .filter(
                (row) =>
                    (rosterProvider.value === undefined || row.provider === rosterProvider.value) &&
                    (query === `` || row.label.toLowerCase().includes(query) || providerLabel(row.provider).toLowerCase().includes(query)),
            )
            // Reconciling one account is what this table is for, and "why is this one doing nothing" is a question its
            // meter columns answer with a dash.
            .map((row) => ({ row, blocked: row.state.kind === `blocked` ? row.state.reason : undefined }))
    );
});
</script>

<template>
    <!-- `@container` over the section: the columns follow the panel's width, not the window's. -->
    <section v-if="rows.length > 0" id="accounts" v-skeleton-source="`sandbox.plan-limits`" class="@container">
        <div class="mb-2.5 px-1">
            <span :class="ui.sectionLabel()">{{ t(`shared.planLimits`) }}</span>
        </div>

        <div class="flex flex-col gap-3">
            <!-- Summary first in the document, so it is read first and stacks on top when narrow; wide, it takes the
                 right-hand column and the full height of the provider cards beside it. -->
            <div :class="SPLIT">
                <Card class="@2xl:col-start-2 @2xl:row-start-1">
                    <!-- Sticks while the provider column scrolls past, since it answers the question every card below it raises. -->
                    <div class="flex flex-col gap-4 @2xl:sticky @2xl:top-4">
                        <!-- 1. CAPACITY: headline is a count, not a percentage, since that question survives having 31 accounts. -->
                        <div class="flex flex-col gap-3">
                            <!-- Answers "can I start work, and if not, when", not a connection count (the roster already does that). -->
                            <div class="flex flex-col gap-1">
                                <!-- Counted against the accounts that could have room, never the whole roster: a credential no turn can run on belongs to the legend below. -->
                                <span class="text-base font-semibold leading-snug text-content">
                                    {{ t(`sandbox.planLimitsPanel.accountsWithRoom`, { count: summary.counts.room, total: capacityTotal }, summary.counts.room) }}
                                </span>
                                <span v-if="summary.nextResetAt !== undefined" class="text-2xs text-subtle"
                                    >{{ t(`sandbox.planLimitsPanel.nextPoolReopens`, { nextResetAt: formatReset(summary.nextResetAt) }) }}
                                </span>
                            </div>

                            <!-- Segments are account counts; a surface gap separates them, so even a single account draws a visible sliver. The
                                 strip is drawn left to right as one, the way the count beside it is read (motion.css `ui-grow-wipe`). -->
                            <div v-if="capacityTotal > 0" class="ui-grow-wipe flex h-1.5 gap-0.5">
                                <div
                                    v-for="segment in capacity"
                                    :key="segment.band"
                                    v-tooltip.top="`${segment.count} ${segment.label}`"
                                    class="ui-meter-fill h-full rounded-full"
                                    :class="planLimitBandTone(segment.band)"
                                    :style="{ width: `${segment.share}%`, ...planLimitBandTint(segment.band) }"
                                />
                            </div>

                            <!-- Legend is the sentence: swatch, count and word together, nothing carried by colour alone. A
                                 row of words when stacked above the providers, a column with the counts lined up on the
                                 right once it has a column of its own. -->
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted @2xl:flex-col @2xl:items-stretch">
                                <span v-for="segment in capacity" :key="segment.band" class="flex items-center gap-1.5">
                                    <span
                                        class="ui-meter-fill size-2 shrink-0 rounded-2xs"
                                        :class="planLimitBandTone(segment.band)"
                                        :style="planLimitBandTint(segment.band)"
                                    />
                                    <span class="tabular-nums text-content @2xl:order-last @2xl:ml-auto">{{ segment.count }}</span>
                                    {{ segment.label }}
                                </span>
                                <!-- Off the bar, so an outline where the others have a fill: counted, never capacity. -->
                                <span v-if="summary.counts.blocked > 0" class="flex items-center gap-1.5 text-danger">
                                    <span class="size-2 shrink-0 rounded-2xs border border-current" />
                                    <span class="tabular-nums @2xl:order-last @2xl:ml-auto">{{ summary.counts.blocked }}</span>
                                    {{ planLimitBandLabel(`blocked`) }}
                                </span>
                                <span v-if="summary.counts.none > 0" class="flex items-center gap-1.5 text-subtle">
                                    <span class="size-2 shrink-0 rounded-2xs border border-current" />
                                    <span class="tabular-nums @2xl:order-last @2xl:ml-auto">{{ summary.counts.none }}</span>
                                    {{ planLimitBandLabel(`none`) }}
                                </span>
                            </div>
                        </div>

                        <!-- 3. ATTENTION: beside the count it explains, since both are about the whole fleet rather than one provider. -->
                        <div v-if="summary.attention.length > 0" class="flex flex-col gap-2 border-t border-line-subtle pt-4">
                            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span class="text-2xs font-medium text-danger">{{ t(`sandbox.planLimitsPanel.cantServeTurn`, { attentionTotal }) }}</span>
                                <span v-if="reconnectTotal > 0" class="text-2xs text-subtle">
                                    {{ t(`sandbox.planLimitsPanel.reconnectOnAgentTab`, { count: reconnectTotal }, reconnectTotal) }}
                                </span>
                                <span v-if="verifyTotal > 0" class="text-2xs text-subtle">
                                    {{ t(`sandbox.planLimitsPanel.verifyEachLink`, { count: verifyTotal }, verifyTotal) }}
                                </span>
                                <span v-if="seatTotal > 0" class="text-2xs text-subtle">
                                    {{ t(`sandbox.planLimitsPanel.seatFromAdmin`, { count: seatTotal }, seatTotal) }}
                                </span>
                            </div>
                            <div v-for="group in attentionShown" :key="group.fix" class="flex flex-col gap-1">
                                <span class="text-2xs text-muted">{{ group.reason }}</span>
                                <span class="text-2xs text-subtle">{{ group.detail }}</span>
                                <!-- Wraps as a set, not a column: names are short, unordered, and scanned for the one you recognise. -->
                                <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                                    <span
                                        v-for="row in group.rows"
                                        :key="row.id"
                                        v-tooltip.top="attentionTip(row)"
                                        class="flex min-w-0 items-center gap-1.5 text-2xs"
                                    >
                                        <ProviderLogo :provider="row.provider" class="shrink-0 text-muted" />
                                        <!-- A verification is done by the account's owner on the provider's own page: the name is that door. -->
                                        <a
                                            v-if="row.state.url !== undefined"
                                            :href="row.state.url"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="min-w-0 truncate text-link hover:underline"
                                            >{{ row.label }}</a
                                        >
                                        <span v-else class="min-w-0 truncate text-muted">{{ row.label }}</span>
                                    </span>
                                    <!-- Never a silent cap, and never a dead end: the rest are one click away, in place. -->
                                    <button
                                        v-if="group.hidden > 0"
                                        type="button"
                                        class="cursor-pointer text-2xs text-link hover:underline"
                                        @click="attentionExpanded = true"
                                    >
                                        {{ t(`sandbox.planLimitsPanel.more`, { hidden: group.hidden }) }}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </Card>

                <!-- 2. PROVIDERS: the unit a reader actually chooses (the translator picks the account), one card each. -->
                <div class="flex min-w-0 flex-col gap-3 @2xl:col-start-1 @2xl:row-start-1">
                    <!-- Each card its own container: a meter lays itself out against the card it sits in, not the section. -->
                    <Card v-for="group in groups" :key="group.provider" class="@container flex gap-2.5">
                        <!-- The mark alone, no rule under it: the column it leaves empty is what says the accounts belong to it. -->
                        <span class="flex size-5 shrink-0 items-center justify-center rounded-md bg-content/10 text-content">
                            <ProviderLogo :provider="group.provider" class="text-xs" />
                        </span>

                        <div class="flex min-w-0 flex-1 flex-col gap-3">
                            <!-- `min-h-5` matches the mark's height, so the name's line holds steady whatever the metadata wraps to. -->
                            <div class="flex min-h-5 flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span class="text-sm font-semibold text-content">{{ providerLabel(group.provider) }}</span>
                                <!-- One account ⇒ its own name, because "1 account" says nothing a reader wanted. -->
                                <span v-if="groupNote(group) !== undefined" class="min-w-0 truncate text-2xs text-subtle">{{ groupNote(group) }}</span>
                                <span v-if="single(group)?.measuredAt !== undefined" class="ml-auto shrink-0 text-2xs text-subtle"
                                    >{{ t(`sandbox.planLimitsPanel.read`, { measuredAt: formatAge(single(group)!.measuredAt!) }) }}
                                </span>
                                <span v-else-if="!isInline(group) && groupState(group) !== ``" class="ml-auto shrink-0 text-2xs text-muted">{{
                                    groupState(group)
                                }}</span>
                            </div>

                            <!-- Flush with the provider's name, not indented past it; smaller, lighter and markless, so an account heading can't read as another provider. -->
                            <div class="flex flex-col gap-3">
                                <!-- Small provider: the meters themselves. Nothing that fits is folded away. -->
                                <template v-if="isInline(group)">
                                    <div v-for="row in group.rows" :key="row.id" class="flex flex-col gap-1.5">
                                        <!-- Account labels sit between the provider and its pools. -->
                                        <div v-if="single(group) === undefined" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                            <span class="min-w-0 truncate text-xs font-medium text-content">{{ row.label }}</span>
                                            <!-- Show the identity only when the account label does not identify it. -->
                                            <span v-if="row.identity !== undefined" class="min-w-0 truncate text-2xs text-subtle">{{
                                                row.identity
                                            }}</span>
                                            <span
                                                v-if="row.measuredAt !== undefined"
                                                class="ml-auto shrink-0 text-2xs"
                                                :class="row.stale ? `text-muted` : `text-subtle`"
                                                >{{ t(`sandbox.planLimitsPanel.read`, { measuredAt: formatAge(row.measuredAt) }) }}
                                            </span>
                                        </div>

                                        <p v-if="row.pools.length === 0" class="text-2xs text-subtle">
                                            {{
                                                row.readable
                                                    ? t(`sandbox.planLimitsPanel.noReadingYet`)
                                                    : t(`sandbox.planLimitsPanel.planPublishesNoLimits`)
                                            }}
                                        </p>

                                        <!-- Narrow layouts wrap meters without hiding reset dates. -->
                                        <!-- A pool inside another (the session inside the week) hangs off it on an elbow, one step in per
                                             level; the elbow sits inside the label's fixed width, so every bar still starts on one line. -->
                                        <div
                                            v-for="({ item: pool, depth, parent, capped }, poolIndex) in nestedPools(row)"
                                            :key="pool.kind"
                                            class="flex flex-wrap items-center gap-x-3 gap-y-1 @xl:flex-nowrap"
                                        >
                                            <span class="flex min-w-0 flex-1 items-center text-2xs text-muted @xl:w-40 @xl:flex-none">
                                                <span
                                                    v-if="depth > 0"
                                                    class="mr-1.5 size-2 shrink-0 -translate-y-0.5 rounded-bl-2xs border-b border-l border-line-strong"
                                                    :style="{ marginLeft: `${0.25 + (depth - 1) * 0.75}rem` }"
                                                    aria-hidden="true"
                                                />
                                                <span class="min-w-0 truncate">{{ pool.label }}</span>
                                                <span v-if="parent !== undefined" class="sr-only">
                                                    {{
                                                        capped
                                                            ? t(`sandbox.planLimitsPanel.cappedBy`, { pool: parent.label })
                                                            : t(`sandbox.planLimitsPanel.insidePool`, { pool: parent.label })
                                                    }}
                                                </span>
                                            </span>
                                            <!-- Drains as turns spend it: the fill is what is left. A spent pool tints its empty track, so
                                                 it can't be mistaken for one with no reading. A nested pool draws thinner, the one holding
                                                 it being the headline, and fades while that one is spent: its room waits on the holder. -->
                                            <div
                                                v-tooltip.top="
                                                    capped && parent !== undefined
                                                        ? {
                                                              title: t(`sandbox.planLimitsPanel.unusable`),
                                                              rows: [{ label: t(`sandbox.planLimitsPanel.waitsOn`), value: parent.label }],
                                                          }
                                                        : undefined
                                                "
                                                class="order-last min-w-0 flex-1 basis-full overflow-hidden rounded-full @xl:order-none @xl:basis-0"
                                                :class="[meterTrack(pool.percent), depth > 0 ? `h-1` : `h-1.5`, capped ? `opacity-40` : ``]"
                                            >
                                                <div
                                                    class="ui-meter-fill ui-grow-x h-full rounded-full"
                                                    :class="usageTone(pool.percent)"
                                                    :style="{ width: `${meterFill(pool.percent)}%`, ...meterTint(pool.percent), '--ui-grow-i': poolIndex }"
                                                />
                                            </div>
                                            <span
                                                class="w-16 shrink-0 text-right text-2xs tabular-nums"
                                                :class="[usageTone(pool.percent), capped ? `opacity-40` : ``]"
                                                :style="meterTint(pool.percent)"
                                            >
                                                {{ formatRemaining(pool.percent, row.stale) }}
                                            </span>
                                            <span class="shrink-0 truncate text-right text-2xs text-subtle @xl:w-32">
                                                {{
                                                    pool.resetsAt === undefined
                                                        ? ``
                                                        : t(`sandbox.planLimitsPanel.resets`, { resetsAt: formatReset(pool.resetsAt) })
                                                }}
                                            </span>
                                        </div>
                                    </div>
                                </template>

                                <!-- Large providers use bars, one per account, each as tall as what it has left; a missing reading keeps an empty neutral track. -->
                                <template v-else>
                                    <div class="flex h-5 items-end gap-0.5">
                                        <span
                                            v-for="(row, barIndex) in barsOf(group)"
                                            :key="row.id"
                                            v-tooltip.top="barTooltip(row)"
                                            class="flex h-full w-1.5 items-end rounded-2xs"
                                            :class="row.percent === undefined ? `bg-content/10` : meterTrack(row.percent)"
                                        >
                                            <span
                                                v-if="row.percent !== undefined"
                                                class="ui-meter-fill ui-grow-y w-full rounded-2xs"
                                                :class="usageTone(row.percent)"
                                                :style="{ height: `${meterFill(row.percent, 5)}%`, ...meterTint(row.percent), '--ui-grow-i': barIndex }"
                                            />
                                        </span>
                                    </div>
                                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
                                        <button type="button" class="cursor-pointer text-link hover:underline" @click="openRoster(group.provider)">
                                            {{ t(`sandbox.planLimitsPanel.viewAccounts`) }}
                                        </button>
                                        <!-- Never a silent cap: a strip that shows 24 of 31 says so. -->
                                        <span v-if="group.rows.length > MAX_BARS" class="text-subtle"
                                            >{{ t(`sandbox.planLimitsPanel.showingMostConstrained`, { max_bars: MAX_BARS, count: group.rows.length }) }}
                                        </span>
                                    </div>
                                </template>
                            </div>
                        </div>
                    </Card>
                </div>
            </div>

            <!-- 4 · ROSTER. The escape hatch: every account, searchable, with the number behind each meter. -->
            <Card class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <button type="button" class="flex cursor-pointer items-center gap-1.5 text-xs text-content" @click="rosterOpen = !rosterOpen">
                        <Icon :name="rosterOpen ? `chevron-down` : `chevron-right`" class="text-muted" />
                        {{ t(`sandbox.planLimitsPanel.allAccounts`) }}
                    </button>
                    <button v-if="rosterProvider !== undefined" type="button" class="ui-chip gap-1" @click="rosterProvider = undefined">
                        {{ providerLabel(rosterProvider) }}<Icon name="times" />
                    </button>
                    <SearchBar
                        v-if="rosterOpen"
                        v-model="rosterQuery"
                        variant="field"
                        clearable
                        :aria-label="t(`chat.words.filterAccounts2`)"
                        :placeholder="t(`chat.words.filterAccounts`)"
                        class="ml-auto w-full @xl:w-56"
                    />
                </div>

                <div v-if="rosterOpen" class="overflow-x-auto">
                    <table class="w-full text-2xs">
                        <thead class="text-left text-subtle">
                            <tr class="border-b border-line-subtle">
                                <th class="py-1.5 pr-3 font-medium">{{ t(`shared.account`) }}</th>
                                <th class="py-1.5 pr-3 font-medium">{{ t(`sandbox.words.provider`) }}</th>
                                <th class="py-1.5 pr-3 font-medium">{{ t(`sandbox.planLimitsPanel.bindingPool`) }}</th>
                                <th class="py-1.5 pr-3 text-right font-medium">{{ t(`sandbox.planLimitsPanel.left`) }}</th>
                                <th class="py-1.5 pr-3 font-medium">{{ t(`sandbox.planLimitsPanel.reopens`) }}</th>
                                <th class="py-1.5 font-medium">{{ t(`sandbox.planLimitsPanel.read2`) }}</th>
                            </tr>
                        </thead>
                        <tbody class="text-muted">
                            <tr v-for="{ row, blocked } in roster" :key="row.id" class="border-b border-line/50">
                                <!-- Account names lead identities so the sign-in target is clear. -->
                                <td class="max-w-56 py-1.5 pr-3">
                                    <span class="block truncate text-content">{{ row.label }}</span>
                                    <span v-if="row.identity !== undefined" class="block truncate text-subtle">{{ row.identity }}</span>
                                    <span v-if="blocked !== undefined" class="block truncate text-danger">{{ blocked }}</span>
                                </td>
                                <td class="py-1.5 pr-3">{{ providerLabel(row.provider) }}</td>
                                <td class="py-1.5 pr-3">
                                    {{ row.binding?.label ?? (row.readable ? `—` : t(`sandbox.planLimitsPanel.noPublishedLimits`)) }}
                                </td>
                                <td
                                    class="py-1.5 pr-3 text-right tabular-nums"
                                    :class="row.percent === undefined ? `` : usageTone(row.percent)"
                                    :style="row.percent === undefined ? {} : meterTint(row.percent)"
                                >
                                    {{ row.percent === undefined ? `—` : remainingFigure(row.percent, row.stale) }}
                                </td>
                                <td class="py-1.5 pr-3">{{ row.binding?.resetsAt === undefined ? `—` : formatReset(row.binding.resetsAt) }}</td>
                                <td class="py-1.5">{{ row.measuredAt === undefined ? t(`sandbox.planLimitsPanel.neverMeasured`) : formatAge(row.measuredAt) }}</td>
                            </tr>
                        </tbody>
                    </table>
                    <p v-if="roster.length === 0" :class="ui.emptyState(`py-4`)">{{ t(`sandbox.planLimitsPanel.noAccountMatchesFilter`) }}</p>
                </div>
            </Card>
        </div>
    </section>

    <!-- An unread state is not an empty one: drawn as the panel itself, as it last looked in this sandbox, or until then
         an outline of it (summary card beside provider cards), not a "Reading..." sentence in its place. -->
    <SkeletonSnapshot v-else-if="!accountsLoaded && outline" of="sandbox.plan-limits" :label="t(`sandbox.words.readingConnections`)">
        <section class="@container" role="status" aria-busy="true">
            <div class="mb-2.5 px-1"><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></div>
            <span class="sr-only">{{ t(`sandbox.words.readingConnections`) }}</span>
            <div :class="SPLIT" aria-hidden="true">
                <Card class="flex flex-col gap-3 @2xl:col-start-2 @2xl:row-start-1">
                    <div class="flex flex-col gap-1.5">
                        <span class="skeleton block h-4 w-44" />
                        <span class="skeleton block h-2.5 w-32" />
                    </div>
                    <!-- Matches the strip's actual height; a thicker placeholder would promise more than the real thing. -->
                    <span class="skeleton block h-1.5 w-full rounded-full" />
                    <div class="flex flex-wrap gap-x-3 gap-y-1.5 @2xl:flex-col">
                        <span v-for="(width, index) in [`w-20`, `w-24`, `w-16`]" :key="index" class="skeleton block h-2.5" :class="width" />
                    </div>
                </Card>
                <div class="flex min-w-0 flex-col gap-3 @2xl:col-start-1 @2xl:row-start-1">
                    <Card v-for="card in 2" :key="card" class="flex gap-2.5">
                        <span class="skeleton block size-5 shrink-0 rounded-md" />
                        <div class="flex min-w-0 flex-1 flex-col gap-3">
                            <span class="skeleton block h-3.5 w-28" />
                            <span class="skeleton block h-1.5 w-full rounded-full" />
                        </div>
                    </Card>
                </div>
            </div>
        </section>
    </SkeletonSnapshot>

    <!-- Said only once it is true, and silent for the beat before the outline earns its place. -->
    <p v-else-if="accountsLoaded" v-skeleton-source="`sandbox.plan-limits`" :class="ui.emptyState()">
        {{ t(`sandbox.planLimitsPanel.noAiAccountConnected`) }}
    </p>
</template>
