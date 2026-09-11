<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { RowGroup, RowNote, SearchBar, ui } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../chat/accounts/providerAccounts";
import { refreshConnections } from "../../chat/accounts/useChat-accounts";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import {
    formatAge,
    formatReset,
    formatUtilization,
    PLAN_LIMIT_BAND_LABEL,
    PLAN_LIMIT_BANDS,
    type PlanLimitGroup,
    planLimitBandTone,
    planLimitGroups,
    type PlanLimitRow,
    planLimitRows,
    planLimitSummary,
    usageTone,
} from "../../chat/session/usageStatus";

// How much of your plans is left, the section that must scale to a 36-connection fleet rather than one row per
// account. A hierarchy, each level answering a different question:
//   1. CAPACITY: can I start work? Counts by band (never a mean of many pools), plus the soonest reopen.
//   2. PROVIDERS: where do I run? The provider is the unit, since the translator picks the account, not the user.
//      Small providers show inline meters; large ones show a distribution and a roster link.
//   3. ATTENTION: what's broken (unrefreshable), narrower than "unavailable": a spent pool reopens on its own
//      and is already counted at level 1.
//   4. ROSTER: a filterable table to reconcile one account.
// Distribution uses bar height, not colour-only cells: this system's severity ramp (orange/amber/red) is
// unreadable as colour alone to a red-weak reader.

// Refreshes on arrival since plan pools are account-wide (other clients spend the same allowance), so a stale
// read looks confidently wrong. Same pattern as AiAccountSection's rings.
onMounted(() => void refreshConnections());

// Module-level flag, not a query, but gated the same way: nothing draws for a read landing in the first beat.
const outline = useSandboxOutline(computed(() => !accountsLoaded.value));

const rows = computed(() => planLimitRows(providerAccounts.value, translatorAccounts.value));
const groups = computed(() => planLimitGroups(rows.value));
const summary = computed(() => planLimitSummary(rows.value));

// capacity

// Excludes unpublished-limit accounts (not a degree of fullness); shown as a count, not an achromatic segment.
const CAPACITY_BANDS = PLAN_LIMIT_BANDS.filter((band) => band !== `none`);
const capacityTotal = computed(() => CAPACITY_BANDS.reduce((sum, band) => sum + summary.value.counts[band], 0));
const capacity = computed(() =>
    CAPACITY_BANDS.filter((band) => summary.value.counts[band] > 0).map((band) => ({
        band,
        count: summary.value.counts[band],
        label: PLAN_LIMIT_BAND_LABEL[band],
        share: (100 * summary.value.counts[band]) / Math.max(1, capacityTotal.value),
    })),
);

// groups

// Up to 3 accounts render inline; folding what already fits hides it for no gain.
const INLINE_LIMIT = 3;
const isInline = (group: PlanLimitGroup): boolean => group.rows.length <= INLINE_LIMIT;
// A single-account provider has no list to head; the group row is that account's row.
const single = (group: PlanLimitGroup): PlanLimitRow | undefined => (group.rows.length === 1 ? group.rows[0] : undefined);

// Names the lone account (with identity if needed), or the count; "1 account" tells nobody anything.
const groupNote = (group: PlanLimitGroup): string => {
    const account = single(group);
    if (account === undefined) {
        return `${group.rows.length} accounts`;
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
        return `tightest ${formatUtilization(group.tightest.percent, group.tightest.stale)} · ${group.tightest.label}`;
    }
    if (group.counts.none === group.rows.length) {
        return `publishes no limits`;
    }
    return `${group.counts.unread} of ${group.rows.length} unread`;
};

const barTooltip = (row: PlanLimitRow): string =>
    row.percent === undefined
        ? `${row.label} · no reading yet`
        : `${row.label} · ${row.binding?.label ?? ``} ${formatUtilization(row.percent, row.stale)}${row.binding?.resetsAt === undefined ? `` : ` · resets ${formatReset(row.binding.resetsAt)}`}`;

// attention

// Caps a fleet-wide expiry (real: a slept laptop, a mass revoke) from reverting this to a long column.
const ATTENTION_SHOWN = 12;
const attentionExpanded = ref(false);
const attentionShown = computed(() => (attentionExpanded.value ? summary.value.attention : summary.value.attention.slice(0, ATTENTION_SHOWN)));
const attentionHidden = computed(() => summary.value.attention.length - attentionShown.value.length);

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
    return rows.value.filter(
        (row) =>
            (rosterProvider.value === undefined || row.provider === rosterProvider.value) &&
            (query === `` || row.label.toLowerCase().includes(query) || providerLabel(row.provider).toLowerCase().includes(query)),
    );
});
</script>

<template>
    <!-- `@container` over the section: columns thin against the panel, not the window's width. -->
    <RowGroup v-if="rows.length > 0" id="accounts" class="@container" label="Plan limits">
        <!-- 1. CAPACITY: headline is a count, not a percentage, since that question survives having 31 accounts. -->
        <RowNote variant="block">
            <div class="flex flex-col gap-2">
                <!-- Answers "can I start work, and if not, when", not a connection count (the roster already does that). -->
                <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span class="text-sm text-content">
                        {{ summary.counts.room }} of {{ summary.accounts }} accounts {{ summary.counts.room === 1 ? `has` : `have` }} room
                    </span>
                    <span v-if="summary.nextResetAt !== undefined" class="ml-auto shrink-0 text-2xs text-subtle">
                        next pool reopens {{ formatReset(summary.nextResetAt) }}
                    </span>
                </div>

                <!-- Segments are account counts; a surface gap separates them, so even a single account draws a visible sliver. -->
                <div v-if="capacityTotal > 0" class="flex h-1.5 gap-0.5">
                    <div
                        v-for="segment in capacity"
                        :key="segment.band"
                        v-tooltip.top="`${segment.count} ${segment.label}`"
                        class="ui-meter-fill h-full rounded-full"
                        :class="planLimitBandTone(segment.band)"
                        :style="{ width: `${segment.share}%` }"
                    />
                </div>

                <!-- Legend is the sentence: swatch, count and word together, nothing carried by colour alone. -->
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                    <span v-for="segment in capacity" :key="segment.band" class="flex items-center gap-1.5">
                        <span class="ui-meter-fill size-2 shrink-0 rounded-2xs" :class="planLimitBandTone(segment.band)" />
                        <span class="tabular-nums text-content">{{ segment.count }}</span>
                        {{ segment.label }}
                    </span>
                    <span v-if="summary.counts.none > 0" class="text-subtle"> · {{ summary.counts.none }} {{ PLAN_LIMIT_BAND_LABEL.none }} </span>
                </div>
            </div>
        </RowNote>

        <!--
            2. PROVIDERS: the unit a reader actually chooses (the translator picks the account). Separated by alignment,
            not framing: a rail with the mark, the name beside it, everything else hanging off a spine one step in, since nested bordered cards read
            as false hierarchy (an account card reading as a provider).
        -->
        <RowNote variant="block">
            <div class="flex flex-col gap-6">
                <div v-for="group in groups" :key="group.provider" class="flex gap-2">
                    <!--
                        Rail: the mark plus a line showing how far the provider reaches. Uses the text colour's own tint, not
                        bg-overlay/bg-canvas, both near-identical to bg-card in light mode.
                    -->
                    <div class="flex w-5 shrink-0 flex-col items-center gap-1.5">
                        <span class="flex size-5 items-center justify-center rounded-md bg-content/10 text-content">
                            <ProviderLogo :provider="group.provider" class="text-xs" />
                        </span>
                        <span class="w-px flex-1 bg-line-strong" aria-hidden="true" />
                    </div>

                    <div class="flex min-w-0 flex-1 flex-col gap-2">
                        <!-- `min-h-5` matches the mark's height, so the name's line holds steady whatever the metadata wraps to. -->
                        <div class="flex min-h-5 flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span class="text-sm font-semibold text-content">{{ providerLabel(group.provider) }}</span>
                            <!-- One account ⇒ its own name, because "1 account" says nothing a reader wanted. -->
                            <span class="min-w-0 truncate text-2xs text-subtle">{{ groupNote(group) }}</span>
                            <span v-if="single(group)?.measuredAt !== undefined" class="ml-auto shrink-0 text-2xs text-subtle">
                                read {{ formatAge(single(group)!.measuredAt!) }}
                            </span>
                            <span v-else-if="!isInline(group)" class="ml-auto shrink-0 text-2xs text-muted">{{ groupState(group) }}</span>
                        </div>

                        <!--
                            Indented one step from the provider's name; smaller, lighter, and markless, so an account heading can't read
                            as another provider.
                        -->
                        <div class="flex flex-col gap-3 pb-1 pl-3">
                            <!-- Small provider: the meters themselves. Nothing that fits is folded away. -->
                            <template v-if="isInline(group)">
                                <!--
                                    Hairline between accounts (none above the first): nine pooled meters in one column need a break, or a "95%"
                                    can't be traced to its account. Faint and indented, unlike the panel's own full-bleed dividers, so it stays
                                    subordinate.
                                -->
                                <div
                                    v-for="(row, index) in group.rows"
                                    :key="row.id"
                                    class="flex flex-col gap-1.5"
                                    :class="single(group) === undefined && index > 0 ? `border-t border-line-subtle pt-3` : ``"
                                >
                                    <!--
                                        Account is its own tier, between the provider heading and the pools it heads, styled to not be mistaken for
                                        either.
                                    -->
                                    <div v-if="single(group) === undefined" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                        <span class="min-w-0 truncate text-xs font-medium text-content">{{ row.label }}</span>
                                        <!-- Shown only when the renamable label doesn't already identify the account; same rule as the Agent tab. -->
                                        <span v-if="row.identity !== undefined" class="min-w-0 truncate text-2xs text-subtle">{{
                                            row.identity
                                        }}</span>
                                        <span
                                            v-if="row.measuredAt !== undefined"
                                            class="ml-auto shrink-0 text-2xs"
                                            :class="row.stale ? `text-muted` : `text-subtle`"
                                        >
                                            read {{ formatAge(row.measuredAt) }}
                                        </span>
                                    </div>

                                    <p v-if="row.pools.length === 0" class="text-2xs text-subtle">
                                        {{
                                            row.readable
                                                ? `No reading yet.`
                                                : `This plan publishes no limits, spend is all this sandbox can tell you.`
                                        }}
                                    </p>

                                    <!--
                                        Narrow: wraps the meter to its own line rather than dropping the reset date, the number this opens for.
                                        Measured against the panel, not the window.
                                    -->
                                    <div
                                        v-for="pool in row.pools"
                                        :key="pool.kind"
                                        class="flex flex-wrap items-center gap-x-3 gap-y-1 @xl:flex-nowrap"
                                    >
                                        <span class="min-w-0 flex-1 truncate text-2xs text-muted @xl:w-40 @xl:flex-none">{{ pool.label }}</span>
                                        <!-- A 0% pool still draws a sliver; an empty track would read the same as no reading at all, opposite facts. -->
                                        <div
                                            class="order-last h-1.5 min-w-0 flex-1 basis-full overflow-hidden rounded-full bg-content/10 @xl:order-none @xl:basis-0"
                                        >
                                            <div
                                                class="ui-meter-fill h-full rounded-full"
                                                :class="usageTone(pool.percent)"
                                                :style="{ width: `${Math.max(pool.percent, 1)}%` }"
                                            />
                                        </div>
                                        <span class="w-12 shrink-0 text-right text-2xs tabular-nums" :class="usageTone(pool.percent)">
                                            {{ formatUtilization(pool.percent, row.stale) }}
                                        </span>
                                        <span class="shrink-0 truncate text-right text-2xs text-subtle @xl:w-32">
                                            {{ pool.resetsAt === undefined ? `` : `resets ${formatReset(pool.resetsAt)}` }}
                                        </span>
                                    </div>
                                </div>
                            </template>

                            <!-- Large provider: bars. No reading draws an empty track, never a zero-height bar; those are opposite claims. -->
                            <template v-else>
                                <div class="flex h-5 items-end gap-0.5">
                                    <span
                                        v-for="row in barsOf(group)"
                                        :key="row.id"
                                        v-tooltip.top="barTooltip(row)"
                                        class="flex h-full w-1.5 items-end rounded-2xs bg-content/10"
                                    >
                                        <span
                                            v-if="row.percent !== undefined"
                                            class="ui-meter-fill w-full rounded-2xs"
                                            :class="usageTone(row.percent)"
                                            :style="{ height: `${Math.max(row.percent, 4)}%` }"
                                        />
                                    </span>
                                </div>
                                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
                                    <button type="button" class="cursor-pointer text-link hover:underline" @click="openRoster(group.provider)">
                                        View accounts
                                    </button>
                                    <!-- Never a silent cap: a strip that shows 24 of 31 says so. -->
                                    <span v-if="group.rows.length > MAX_BARS" class="text-subtle">
                                        showing the {{ MAX_BARS }} most constrained of {{ group.rows.length }}
                                    </span>
                                </div>
                            </template>
                        </div>
                    </div>
                </div>
            </div>
        </RowNote>

        <!-- 3. ATTENTION: one condition, stated once in the heading; the fix stays there too, so rows hold nothing but names. -->
        <RowNote v-if="summary.attention.length > 0" variant="block">
            <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span class="text-2xs font-medium text-danger">Sign-in expired · {{ summary.attention.length }}</span>
                    <span class="text-2xs text-subtle"> reconnect {{ summary.attention.length === 1 ? `it` : `them` }} on the Agent tab </span>
                </div>
                <!-- Wraps as a set, not a column: names are short, unordered, and scanned for the one you recognise. -->
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span v-for="row in attentionShown" :key="row.id" v-tooltip.top="row.identity" class="flex min-w-0 items-center gap-1.5 text-2xs">
                        <ProviderLogo :provider="row.provider" class="shrink-0 text-muted" />
                        <span class="min-w-0 truncate text-muted">{{ row.label }}</span>
                    </span>
                    <!-- Never a silent cap, and never a dead end: the rest are one click away, in place. -->
                    <button
                        v-if="attentionHidden > 0"
                        type="button"
                        class="cursor-pointer text-2xs text-link hover:underline"
                        @click="attentionExpanded = true"
                    >
                        +{{ attentionHidden }} more
                    </button>
                </div>
            </div>
        </RowNote>

        <!-- 4 · ROSTER. The escape hatch: every account, searchable, with the number behind each meter. -->
        <RowNote variant="block">
            <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <button type="button" class="flex cursor-pointer items-center gap-1.5 text-2xs text-content" @click="rosterOpen = !rosterOpen">
                        <Icon :name="rosterOpen ? `chevron-down` : `chevron-right`" class="text-muted" />
                        All accounts
                        <span class="text-subtle">{{ rows.length }}</span>
                    </button>
                    <button v-if="rosterProvider !== undefined" type="button" class="ui-chip gap-1 px-2 py-0.5" @click="rosterProvider = undefined">
                        {{ providerLabel(rosterProvider) }}<Icon name="times" />
                    </button>
                    <SearchBar
                        v-if="rosterOpen"
                        v-model="rosterQuery"
                        variant="field"
                        clearable
                        aria-label="Filter accounts"
                        placeholder="Filter accounts…"
                        class="ml-auto w-full @xl:w-56"
                    />
                </div>

                <div v-if="rosterOpen" class="scrollbar-thin overflow-x-auto">
                    <table class="w-full text-2xs">
                        <thead class="text-left text-subtle">
                            <tr class="border-b border-line-subtle">
                                <th class="py-1.5 pr-3 font-medium">Account</th>
                                <th class="py-1.5 pr-3 font-medium">Provider</th>
                                <th class="py-1.5 pr-3 font-medium">Binding pool</th>
                                <th class="py-1.5 pr-3 text-right font-medium">Used</th>
                                <th class="py-1.5 pr-3 font-medium">Reopens</th>
                                <th class="py-1.5 font-medium">Read</th>
                            </tr>
                        </thead>
                        <tbody class="text-muted">
                            <tr v-for="row in roster" :key="row.id" class="border-b border-line/50">
                                <!-- Name over sign-in identity: reconciling an unplaceable name is exactly why a reader opens this table. -->
                                <td class="max-w-56 py-1.5 pr-3">
                                    <span class="block truncate text-content">{{ row.label }}</span>
                                    <span v-if="row.identity !== undefined" class="block truncate text-subtle">{{ row.identity }}</span>
                                </td>
                                <td class="py-1.5 pr-3">{{ providerLabel(row.provider) }}</td>
                                <td class="py-1.5 pr-3">{{ row.binding?.label ?? (row.readable ? `—` : `no published limits`) }}</td>
                                <td class="py-1.5 pr-3 text-right tabular-nums" :class="row.percent === undefined ? `` : usageTone(row.percent)">
                                    {{ row.percent === undefined ? `—` : formatUtilization(row.percent, row.stale) }}
                                </td>
                                <td class="py-1.5 pr-3">{{ row.binding?.resetsAt === undefined ? `—` : formatReset(row.binding.resetsAt) }}</td>
                                <td class="py-1.5">{{ row.measuredAt === undefined ? `never` : formatAge(row.measuredAt) }}</td>
                            </tr>
                        </tbody>
                    </table>
                    <p v-if="roster.length === 0" :class="ui.emptyState(`py-4`)">No account matches that filter.</p>
                </div>
            </div>
        </RowNote>
    </RowGroup>

    <!--
        An unread state is not an empty one: drawn as the panel itself (headline, band strip, legend), not a
        "Reading..." sentence in its place.
    -->
    <RowGroup v-else-if="!accountsLoaded && outline" class="@container" role="status" aria-busy="true">
        <template #label><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></template>
        <span class="sr-only">Reading your connections…</span>
        <RowNote variant="block" aria-hidden="true">
            <div class="flex flex-col gap-2">
                <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span class="skeleton block h-4 w-52" />
                    <span class="skeleton ml-auto block h-2.5 w-32" />
                </div>
                <!-- Matches the strip's actual 1.5px height; a thicker placeholder would promise more than the real thing. -->
                <span class="skeleton block h-1.5 w-full rounded-full" />
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span v-for="(width, index) in [`w-20`, `w-24`, `w-16`]" :key="index" class="skeleton block h-2.5" :class="width" />
                </div>
            </div>
        </RowNote>
    </RowGroup>

    <!-- Said only once it is true, and silent for the beat before the outline earns its place. -->
    <p v-else-if="accountsLoaded" :class="ui.emptyState()">
        No AI account is connected yet: connect one on the Agent tab and its plan limits appear here.
    </p>
</template>
