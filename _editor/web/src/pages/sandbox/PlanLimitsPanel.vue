<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { ui, RowGroup, SearchBar } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import { accountsLoaded, providerAccounts, providerRefusals, translatorAccounts } from "../../composables/chat/providerAccounts";
import { refreshConnections } from "../../composables/chat/useChat";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
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
} from "../../composables/chat/usageStatus";

/* HOW MUCH OF YOUR PLANS IS LEFT: the Usage tab's second subject, and the one that does not scale with a row
 * per account. This sandbox holds 36 connections, 31 of them Google, and the flat list this replaced spent
 * 2,300px restating "No reading yet." while the three accounts with real numbers scrolled off the top.
 *
 * The redesign is a hierarchy, and each level exists because a different question is asked at it:
 *
 *   1. CAPACITY, can I start work at all? Counts of accounts by band, never a mean utilization: averaging 31
 *      separate pools describes no account and hides the one that is spent. Plus the soonest reopen, which is
 *      the only number that answers "and if not, when".
 *   2. PROVIDERS, where do I run? The provider is the unit because the provider is the CHOICE: the translator
 *      balances turns across a provider's accounts, so "which of my 31 Google accounts" is not a decision a
 *      person makes. Small providers keep their meters inline (three of anything is not worth folding); large
 *      ones show the distribution as bars and hand the detail to the roster.
 *   3. ATTENTION, what is BROKEN, which is narrower than what is unavailable: a credential that can no longer
 *      be refreshed, and nothing else. A spent pool is not broken: it reopens on its own, the translator routes
 *      around it meanwhile, and since spend is the steady state of a 36-account fleet, listing it here made this
 *      section longest at the exact moment nothing was wrong. Level 1 already counts it and dates its return.
 *   4. ROSTER: reconcile one account. A filterable table, because 36 near-identical gmail addresses are only
 *      navigable by search, and because a number a reader distrusts must be findable.
 *
 * Encoding note: the distribution is BARS (fill height = utilization), not coloured cells. This design system's
 * severity ramp is link → warning → danger = brand orange → amber → red, three warm hues that a red-weak reader
 * cannot separate. Beside a printed percentage that is fine, which is why the meters keep it; as a colour-only
 * strip of 31 cells it would carry the whole message in the one channel that fails. Height says it instead, and
 * colour agrees with it. */

/* Ask for the readings this panel exists to draw, rather than drawing whichever ones the page happened to load
 * with. A plan's pools are ACCOUNT-wide: the desktop app, another Claude Code and claude.ai itself spend the
 * same allowance, so a percentage is only ever as true as it is recent, and a browser left open all afternoon
 * has an afternoon-old one. The connection read is what refreshes them (the daemon waits on a quota sweep
 * before answering it), so arriving on this tab is exactly the moment to ask. AiAccountSection does the same
 * for the rings it draws. */
onMounted(() => void refreshConnections());

// The connection read is a module-level flag rather than a query, but the wait is the same one and gets the same
// gate: nothing is drawn for a read that lands in the first beat.
const outline = useSandboxOutline(computed(() => !accountsLoaded.value));

const rows = computed(() => planLimitRows(providerAccounts.value, translatorAccounts.value));
const groups = computed(() => planLimitGroups(rows.value, providerRefusals.value));
const summary = computed(() => planLimitSummary(rows.value));

// ---- capacity ------------------------------------------------------------------------------------------------

/* The bar covers every account whose headroom is KNOWABLE. A plan that publishes no limits is not a degree of
 * fullness and gets a sentence instead of a segment: two achromatic segments side by side would read as one
 * fact split in half. */
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

// ---- groups --------------------------------------------------------------------------------------------------

/* Up to three accounts render as the meters themselves. Folding three rows behind a click hides something that
 * already fits, and a "distribution" of three bars is just three bars: the aggregate only starts paying for
 * itself when the list stops fitting on screen. */
const INLINE_LIMIT = 3;
const isInline = (group: PlanLimitGroup): boolean => group.rows.length <= INLINE_LIMIT;
// A provider with ONE account has no list to head: the group row IS that account's row, so it carries the label
// and the read age itself. Rendering both produced "Kimi Code · 1 account" directly above a lone "kimi".
const single = (group: PlanLimitGroup): PlanLimitRow | undefined => (group.rows.length === 1 ? group.rows[0] : undefined);

// What the provider line says after the provider's name: the lone account it holds, named, and identified when
// the name alone doesn't: else how many there are. "1 account" is a fact nobody came here for.
const groupNote = (group: PlanLimitGroup): string => {
    const account = single(group);
    if (account === undefined) {
        return `${group.rows.length} accounts`;
    }
    return account.identity === undefined ? account.label : `${account.label} · ${account.identity}`;
};

/* WHERE A REFUSAL BELONGS. The daemon names the account it was serving whenever it has one to name (a native
 * turn does; a routed turn is served by whichever auth file CLIProxyAPI picked, so it names nobody), and drawing
 * that on the provider line instead reads as "all of Claude Code is broken", which is what put a three-hour-old
 * 401 above three accounts that had been serving turns all afternoon.
 *
 * So it goes on its own account's block, wherever that block exists. A folded group draws none, and a lone
 * account IS the provider line; both keep the line at group level and name the account inside it instead. */
const refusedRowId = (group: PlanLimitGroup): string | undefined =>
    isInline(group) && single(group) === undefined ? group.refusedRow?.id : undefined;

// Never all 31: past this the bars are hairlines and the roster is the better answer. Rows arrive tightest-first,
// so a truncated strip keeps the accounts that gate a turn, and says that it truncated.
const MAX_BARS = 24;
const barsOf = (group: PlanLimitGroup): readonly PlanLimitRow[] => group.rows.slice(0, MAX_BARS);

/* What a FOLDED group states in place of a percentage of its own: the account that gates it first, or, when
 * nothing in it has been read, which kind of nothing that is. An inline group says nothing here: its meters are
 * directly below, and a summary of three visible rows is the same sentence twice. */
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
        : `${row.label} · ${row.binding?.label ?? ``} ${formatUtilization(row.percent, row.stale)}` +
          (row.binding?.resetsAt === undefined ? `` : ` · resets ${formatReset(row.binding.resetsAt)}`);

// ---- attention -------------------------------------------------------------------------------------------------

/* A cap, because "every credential in the fleet expired at once" is a real morning: a laptop that slept through
 * a token rotation, a provider that revoked a batch, and it must not turn the section back into the column this
 * redesign removed. Generous enough that the ordinary case (one or two) never trips it. */
const ATTENTION_SHOWN = 12;
const attentionExpanded = ref(false);
const attentionShown = computed(() => (attentionExpanded.value ? summary.value.attention : summary.value.attention.slice(0, ATTENTION_SHOWN)));
const attentionHidden = computed(() => summary.value.attention.length - attentionShown.value.length);

// ---- the roster ------------------------------------------------------------------------------------------------

const rosterOpen = ref(false);
const rosterProvider = ref<string | undefined>(undefined);
const rosterQuery = ref(``);

// A group's "view accounts" opens the ONE detail view rather than a second inline copy of it: the table is where
// per-account facts live, so a reader who drills in from two places lands in the same place.
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
    <!-- A @container over the whole section: every column below thins out against the PANEL, which is a hub
         section inside the workspace pane and never the width of the window. -->
    <RowGroup v-if="rows.length > 0" id="accounts" class="@container" label="Plan limits">
        <!-- 1 · CAPACITY. The section's headline is a count, not a percentage: "how many accounts can I run
             on" is the question, and it survives having 31 of them. -->
        <div class="flex flex-col gap-2 px-4 py-3">
            <!-- The headline answers the question the section is opened with: can I start work, and if not,
                 when: rather than counting connections, which the roster below does anyway. -->
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="text-sm text-content">
                    {{ summary.counts.room }} of {{ summary.accounts }} accounts {{ summary.counts.room === 1 ? `has` : `have` }} room
                </span>
                <span v-if="summary.nextResetAt !== undefined" class="ml-auto shrink-0 text-2xs text-subtle">
                    next pool reopens {{ formatReset(summary.nextResetAt) }}
                </span>
            </div>

            <!-- Segments are ACCOUNT COUNTS. A 2px surface gap does the separating, so no segment needs a
                 border, and a band with one account still draws a visible sliver. -->
            <div v-if="capacityTotal > 0" class="flex h-1.5 gap-0.5">
                <div
                    v-for="segment in capacity"
                    :key="segment.band"
                    v-tooltip.top="`${segment.count} ${segment.label}`"
                    class="h-full rounded-full bg-current"
                    :class="planLimitBandTone(segment.band)"
                    :style="{ width: `${segment.share}%` }"
                />
            </div>

            <!-- The legend IS the sentence: every band is a swatch AND its count AND its word, so nothing here
                 is carried by colour alone. -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                <span v-for="segment in capacity" :key="segment.band" class="flex items-center gap-1.5">
                    <span class="size-2 shrink-0 rounded-[2px] bg-current" :class="planLimitBandTone(segment.band)" />
                    <span class="tabular-nums text-content">{{ segment.count }}</span>
                    {{ segment.label }}
                </span>
                <span v-if="summary.counts.none > 0" class="text-subtle"> · {{ summary.counts.none }} {{ PLAN_LIMIT_BAND_LABEL.none }} </span>
            </div>
        </div>

        <!-- 2 · PROVIDERS. The provider is the CHOICE a reader makes here — the translator balances turns
             across a provider's accounts, so "which of my 31 Google accounts" is nobody's decision — which
             makes it the tier that has to be separated, and the separator is ALIGNMENT rather than a frame.
             Each provider's mark sits in a rail of its own; its NAME is the only thing on the column beside
             that rail; everything the provider holds hangs off a spine under the mark, one step further in.
             Read down the left edge and you get the list of providers, and nothing else on the panel.

             A BORDERED CARD PER PROVIDER IS WHAT THIS REPLACED, and it blended the tiers rather than parting
             them. The panel is already one bordered surface (RowGroup), so a card per provider is a second
             frame inside it and an inset panel per account a third — and at three accounts those inner panels
             read as cards in their own right, directly under cards they were nested in: an email came out
             looking exactly like a provider, which is the confusion the boxes were drawn to fix. The tint
             doing that work (`bg-overlay`) is also `bg-card`'s own colour in the LIGHT scheme, so half of it
             was invisible there. Whitespace and a left edge cost no ink, work in both schemes, and cannot be
             mistaken for one another. -->
        <div class="flex flex-col gap-6 px-4 py-4">
            <div v-for="group in groups" :key="group.provider" class="flex gap-2">
                <!-- THE RAIL: the mark, and under it the line that says how far this provider reaches. The
                     chip is the meter track's own tint of the TEXT colour, because that is the one inset that
                     exists in both schemes — `bg-overlay` and `bg-canvas` are within a percent of `bg-card` in
                     light, which is a grouping cue that disappears for half the app's readers. -->
                <div class="flex w-5 shrink-0 flex-col items-center gap-1.5">
                    <span class="flex size-5 items-center justify-center rounded-md bg-content/10 text-content">
                        <ProviderLogo :provider="group.provider" class="text-xs" />
                    </span>
                    <span class="w-px flex-1 bg-line-strong" aria-hidden="true" />
                </div>

                <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <!-- `min-h-5` is the mark's own height, so the name keeps its line beside the mark however
                         the metadata after it wraps. -->
                    <div class="flex min-h-5 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span class="text-sm font-semibold text-content">{{ providerLabel(group.provider) }}</span>
                        <!-- One account ⇒ its own name, because "1 account" says nothing a reader wanted. -->
                        <span class="min-w-0 truncate text-2xs text-subtle">{{ groupNote(group) }}</span>
                        <span v-if="single(group)?.measuredAt !== undefined" class="ml-auto shrink-0 text-2xs text-subtle">
                            read {{ formatAge(single(group)!.measuredAt!) }}
                        </span>
                        <span v-else-if="!isInline(group)" class="ml-auto shrink-0 text-2xs text-muted">{{ groupState(group) }}</span>
                    </div>

                    <!-- ONE STEP IN FROM THE PROVIDER'S NAME. The name then owns its column outright, and an
                         account heading — set smaller and lighter, and with no mark of its own — cannot be
                         read as another provider, which is exactly what three emails under "Claude Code" used
                         to be read as. -->
                    <div class="flex flex-col gap-3 pb-1 pl-3">
                        <!-- The last time this provider refused a turn, when it belongs to no block of its own (see
                             refusedRowId): named with its account where the daemon knew one, because a bare provider-wide
                             refusal over 24 bars answers "which of these do I go and fix?" with nothing.
                             It sits ABOVE the meters because it OVERRIDES them while it is current: a meter is a poll and
                             this is an observation, so a green bar under a fresh refusal means the poll is stale, not that
                             there is room. Once something taken since has answered it, it drops to a footnote saying so and
                             the provider's own sentence moves to the hover. Two lines at most: the vendors' sentences run to
                             a paragraph with a pricing URL on the end, and the part that matters is at the front. -->
                        <p
                            v-if="group.refusal !== undefined && refusedRowId(group) === undefined"
                            class="line-clamp-2 text-2xs"
                            :class="group.refusal.current ? `text-warning` : `text-subtle`"
                            v-tooltip.top="group.refusal.detail"
                        >
                            {{ group.refusedRow === undefined ? group.refusal.line : `${group.refusedRow.label} · ${group.refusal.line}` }}
                        </p>

                        <!-- Small provider: the meters themselves. Nothing that fits is folded away. -->
                        <template v-if="isInline(group)">
                            <!-- A hairline between accounts, and none above the first: three accounts of three pools each
                                 is nine meters in one column, and without a break the reader has to count rows to know
                                 which account a "95%" belongs to. It is the FAINT line and it starts inside the indent,
                                 where the panel's own section dividers are full-bleed: a separator that is subordinate
                                 has to look subordinate, or the panel reads as nine sections instead of four. -->
                            <div
                                v-for="(row, index) in group.rows"
                                :key="row.id"
                                class="flex flex-col gap-1.5"
                                :class="single(group) === undefined && index > 0 ? `border-t border-line-subtle pt-3` : ``"
                            >
                                <!-- THE ACCOUNT IS A TIER OF ITS OWN: one step under the provider heading it, one over
                                     the pools it heads. It used to be set exactly like a pool label, same size and same
                                     colour, directly above three of them: an email read as a fourth pool that happened
                                     to have no meter, and the eye had nothing to group the meters by. -->
                                <div v-if="single(group) === undefined" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                    <span class="min-w-0 truncate text-xs font-medium text-content">{{ row.label }}</span>
                                    <!-- Whose sign-in this is, when the NAME does not already say it. The label is the
                                         user's to rename and starts as whatever the provider offered, so one row reads
                                         "Claude" beside two emails and identifies nothing: the same rule, and the same
                                         answer, as the Agent tab's identity note. -->
                                    <span v-if="row.identity !== undefined" class="min-w-0 truncate text-2xs text-subtle">{{ row.identity }}</span>
                                    <span
                                        v-if="row.measuredAt !== undefined"
                                        class="ml-auto shrink-0 text-2xs"
                                        :class="row.stale ? `text-muted` : `text-subtle`"
                                    >
                                        read {{ formatAge(row.measuredAt) }}
                                    </span>
                                </div>

                                <!-- This account's own refusal, under its own name: see refusedRowId. -->
                                <p
                                    v-if="group.refusal !== undefined && refusedRowId(group) === row.id"
                                    class="line-clamp-2 text-2xs"
                                    :class="group.refusal.current ? `text-warning` : `text-subtle`"
                                    v-tooltip.top="group.refusal.detail"
                                >
                                    {{ group.refusal.line }}
                                </p>

                                <p v-if="row.pools.length === 0" class="text-2xs text-subtle">
                                    {{ row.readable ? `No reading yet.` : `This plan publishes no limits, spend is all this sandbox can tell you.` }}
                                </p>

                                <!-- A narrow PANEL keeps the reset instead of dropping it: "when does this reopen" is
                                     the number this is opened for: by wrapping the meter onto its own full-width line;
                                     with room, everything sits on one line in fixed columns so rows align. Measured on
                                     the panel, not the window: this is a hub section inside the workspace pane. -->
                                <div v-for="pool in row.pools" :key="pool.kind" class="flex flex-wrap items-center gap-x-3 gap-y-1 @xl:flex-nowrap">
                                    <span class="min-w-0 flex-1 truncate text-2xs text-muted @xl:w-40 @xl:flex-none">{{ pool.label }}</span>
                                    <!-- A pool at 0% still draws a sliver: an empty track is indistinguishable from a
                                         pool this screen has no reading for, and those mean opposite things. -->
                                    <div
                                        class="order-last h-1.5 min-w-0 flex-1 basis-full overflow-hidden rounded-full bg-content/10 @xl:order-none @xl:basis-0"
                                    >
                                        <div
                                            class="h-full rounded-full bg-current"
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

                        <!-- Large provider: the distribution, as bars. An account with no reading draws an EMPTY track
                             and never a zero-height bar: "0% used" and "we have no idea" are opposite claims, and the
                             second one is what is true. -->
                        <template v-else>
                            <div class="flex h-5 items-end gap-0.5">
                                <span
                                    v-for="row in barsOf(group)"
                                    :key="row.id"
                                    v-tooltip.top="barTooltip(row)"
                                    class="flex h-full w-1.5 items-end rounded-[2px] bg-content/10"
                                >
                                    <span
                                        v-if="row.percent !== undefined"
                                        class="w-full rounded-[2px] bg-current"
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

        <!-- 3 · ATTENTION. One condition, so the FIX IS STATED ONCE and the list is nothing but accounts.
             Every entry used to carry its own copy of "sign-in expired: reconnect it on the Agent tab", which
             on a fleet meant the same eleven words down the whole column and the only part that varied, which
             account: wedged between two repetitions of the part that didn't. The heading holds the condition
             and the instruction; the rows hold names. -->
        <div v-if="summary.attention.length > 0" class="flex flex-col gap-2 px-4 py-3">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span class="text-2xs font-medium text-danger">Sign-in expired · {{ summary.attention.length }}</span>
                <span class="text-2xs text-subtle"> reconnect {{ summary.attention.length === 1 ? `it` : `them` }} on the Agent tab </span>
            </div>
            <!-- Names wrap as a set rather than stacking one per line: they are short, unordered and read by
                 scanning for the one you recognise, so a column of them is height spent on nothing. -->
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

        <!-- 4 · ROSTER. The escape hatch: every account, searchable, with the number behind each meter. -->
        <div class="flex flex-col gap-2 px-4 py-2.5">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <button type="button" class="flex cursor-pointer items-center gap-1.5 text-2xs text-content" @click="rosterOpen = !rosterOpen">
                    <Icon :name="rosterOpen ? `chevron-down` : `chevron-right`" class="text-muted" />
                    All accounts
                    <span class="text-subtle">{{ rows.length }}</span>
                </button>
                <button
                    v-if="rosterProvider !== undefined"
                    type="button"
                    class="flex cursor-pointer items-center gap-1 rounded-full bg-overlay px-2 py-0.5 text-2xs text-muted hover:text-content"
                    @click="rosterProvider = undefined"
                >
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
                            <!-- Name over sign-in identity, because this table is where a reader comes to
                                 reconcile ONE account and a name it can't place is the whole reason they came. -->
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
    </RowGroup>

    <!-- An unread state is not an empty one: until the connection read lands, this says nothing about having no
         accounts. It used to say that in words ("Reading your connections…"), which is a sentence where a panel
         goes, so the wait is drawn as the panel instead: the capacity headline, the band strip under it, and
         its legend, which is the whole of what lands here. -->
    <RowGroup v-else-if="!accountsLoaded && outline" class="@container" role="status" aria-busy="true">
        <template #label><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></template>
        <span class="sr-only">Reading your connections…</span>
        <div class="flex flex-col gap-2 px-4 py-3" aria-hidden="true">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="skeleton block h-4 w-52" />
                <span class="skeleton ml-auto block h-2.5 w-32" />
            </div>
            <!-- The band strip is a single 1.5px-tall rule of segments, so its outline is one bar of that
                 height rather than blocks: a placeholder thicker than the thing it stands for is a promise the
                 panel then breaks. -->
            <span class="skeleton block h-1.5 w-full rounded-full" />
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span v-for="(width, index) in [`w-20`, `w-24`, `w-16`]" :key="index" class="skeleton block h-2.5" :class="width" />
            </div>
        </div>
    </RowGroup>

    <!-- Said only once it is true, and silent for the beat before the outline earns its place. -->
    <p v-else-if="accountsLoaded" :class="ui.emptyState()">
        No AI account is connected yet: connect one on the Agent tab and its plan limits appear here.
    </p>
</template>
