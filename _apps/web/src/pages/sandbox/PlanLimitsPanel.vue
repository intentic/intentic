<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { cmp, RowGroup } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import { accountsLoaded, providerAccounts, providerRefusals, translatorAccounts } from "../../composables/chat/providerAccounts";
import { useChat } from "../../composables/chat/useChat";
import {
    formatAge,
    formatReset,
    formatUtilization,
    PLAN_LIMIT_BAND_LABEL,
    PLAN_LIMIT_BANDS,
    type PlanLimitGroup,
    planLimitBand,
    planLimitBandTone,
    planLimitGroups,
    type PlanLimitRow,
    planLimitRows,
    planLimitSummary,
    refusalIsCurrent,
    refusalLine,
    usageTone,
} from "../../composables/chat/usageStatus";

/* HOW MUCH OF YOUR PLANS IS LEFT — the Usage tab's second subject, and the one that does not scale with a row
 * per account. This sandbox holds 36 connections, 31 of them Google, and the flat list this replaced spent
 * 2,300px restating "No reading yet." while the three accounts with real numbers scrolled off the top.
 *
 * The redesign is a hierarchy, and each level exists because a different question is asked at it:
 *
 *   1. CAPACITY — can I start work at all? Counts of accounts by band, never a mean utilization: averaging 31
 *      separate pools describes no account and hides the one that is spent. Plus the soonest reopen, which is
 *      the only number that answers "and if not, when".
 *   2. PROVIDERS — where do I run? The provider is the unit because the provider is the CHOICE: the translator
 *      balances turns across a provider's accounts, so "which of my 31 Google accounts" is not a decision a
 *      person makes. Small providers keep their meters inline (three of anything is not worth folding); large
 *      ones show the distribution as bars and hand the detail to the roster.
 *   3. ATTENTION — what is broken? Spent or unauthenticated accounts only. A list of everything is what this
 *      section is trying to stop being.
 *   4. ROSTER — reconcile one account. A filterable table, because 36 near-identical gmail addresses are only
 *      navigable by search, and because a number a reader distrusts must be findable.
 *
 * Encoding note: the distribution is BARS (fill height = utilization), not coloured cells. This design system's
 * severity ramp is link → warning → danger = brand orange → amber → red, three warm hues that a red-weak reader
 * cannot separate. Beside a printed percentage that is fine, which is why the meters keep it; as a colour-only
 * strip of 31 cells it would carry the whole message in the one channel that fails. Height says it instead, and
 * colour agrees with it. */

/* Ask for the readings this panel exists to draw, rather than drawing whichever ones the page happened to load
 * with. A plan's pools are ACCOUNT-wide — the desktop app, another Claude Code and claude.ai itself spend the
 * same allowance — so a percentage is only ever as true as it is recent, and a browser left open all afternoon
 * has an afternoon-old one. The connection read is what refreshes them (the daemon waits on a quota sweep
 * before answering it), so arriving on this tab is exactly the moment to ask. AiAccountSection does the same
 * for the rings it draws. */
const { refreshConnections } = useChat();
onMounted(() => void refreshConnections());

const rows = computed(() => planLimitRows(providerAccounts.value, translatorAccounts.value));
const groups = computed(() => planLimitGroups(rows.value, providerRefusals.value));
const summary = computed(() => planLimitSummary(rows.value));

// ---- capacity ------------------------------------------------------------------------------------------------

/* The bar covers every account whose headroom is KNOWABLE. A plan that publishes no limits is not a degree of
 * fullness and gets a sentence instead of a segment — two achromatic segments side by side would read as one
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
 * already fits, and a "distribution" of three bars is just three bars — the aggregate only starts paying for
 * itself when the list stops fitting on screen. */
const INLINE_LIMIT = 3;
const isInline = (group: PlanLimitGroup): boolean => group.rows.length <= INLINE_LIMIT;
// A provider with ONE account has no list to head: the group row IS that account's row, so it carries the label
// and the read age itself. Rendering both produced "Kimi Code · 1 account" directly above a lone "kimi".
const single = (group: PlanLimitGroup): PlanLimitRow | undefined => (group.rows.length === 1 ? group.rows[0] : undefined);

// Never all 31: past this the bars are hairlines and the roster is the better answer. Rows arrive tightest-first,
// so a truncated strip keeps the accounts that gate a turn — and says that it truncated.
const MAX_BARS = 24;
const barsOf = (group: PlanLimitGroup): readonly PlanLimitRow[] => group.rows.slice(0, MAX_BARS);

/* What a FOLDED group states in place of a percentage of its own: the account that gates it first, or — when
 * nothing in it has been read — which kind of nothing that is. An inline group says nothing here: its meters are
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
    <RowGroup
        v-if="rows.length > 0"
        id="accounts"
        label="Plan limits"
        caption="your whole plan, not this sandbox — every device on the account spends the same pools"
    >
        <!-- 1 · CAPACITY. The section's headline is a count, not a percentage: "how many accounts can I run
             on" is the question, and it survives having 31 of them. -->
        <div class="flex flex-col gap-2 px-4 py-3">
            <!-- The headline answers the question the section is opened with — can I start work, and if not,
                 when — rather than counting connections, which the roster below does anyway. -->
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

        <!-- 2 · PROVIDERS. One row per provider — the axis a person actually chooses along. -->
        <div v-for="group in groups" :key="group.provider" class="flex flex-col gap-2.5 px-4 py-3">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <ProviderLogo :provider="group.provider" class="shrink-0 self-center text-sm text-muted" />
                <span class="text-sm text-content">{{ providerLabel(group.provider) }}</span>
                <!-- One account ⇒ its own name, because "1 account" says nothing a reader wanted. -->
                <span class="min-w-0 truncate text-2xs text-subtle">
                    {{ single(group)?.label ?? `${group.rows.length} accounts` }}
                </span>
                <span v-if="single(group)?.measuredAt !== undefined" class="ml-auto shrink-0 text-2xs text-subtle">
                    read {{ formatAge(single(group)!.measuredAt!) }}
                </span>
                <span v-else-if="!isInline(group)" class="ml-auto shrink-0 text-2xs text-muted">{{ groupState(group) }}</span>
            </div>

            <!-- What the provider itself said, the last time it refused a turn. Above the meters because it
                 OVERRIDES them when it is current: a meter is a poll and this is an observation, so a green bar
                 under a fresh refusal means the poll is stale, not that there is room. Dimmed once a reading
                 taken since has found headroom — kept, because "this refused on Tuesday" is still context, but
                 no longer shouted. Two lines at most: the vendors' sentences run to a paragraph with a pricing
                 URL on the end, and the part that matters is at the front. -->
            <p
                v-if="group.refusal"
                class="line-clamp-2 text-2xs"
                :class="refusalIsCurrent(group.refusal, group.rows) ? `text-warning` : `text-subtle`"
                v-tooltip.top.overflow="refusalLine(group.refusal)"
            >
                {{ refusalLine(group.refusal) }}
            </p>

            <!-- Small provider: the meters themselves, exactly as before. Nothing that fits is folded away. -->
            <template v-if="isInline(group)">
                <div v-for="row in group.rows" :key="row.id" class="flex flex-col gap-1.5">
                    <div v-if="single(group) === undefined" class="flex items-baseline gap-2">
                        <span class="min-w-0 truncate text-2xs text-muted">{{ row.label }}</span>
                        <span v-if="row.measuredAt !== undefined" class="ml-auto shrink-0 text-2xs" :class="row.stale ? `text-muted` : `text-subtle`">
                            read {{ formatAge(row.measuredAt) }}
                        </span>
                    </div>

                    <p v-if="row.pools.length === 0" class="text-2xs text-subtle">
                        {{ row.readable ? `No reading yet.` : `This plan publishes no limits — spend is all this sandbox can tell you.` }}
                    </p>

                    <!-- Narrow screens keep the reset instead of dropping it — "when does this reopen" is the
                         number a phone is pulled out for — by wrapping the meter onto its own full-width line;
                         from sm up everything sits on one line in fixed columns so rows align. -->
                    <div v-for="pool in row.pools" :key="pool.kind" class="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap">
                        <span class="min-w-0 flex-1 truncate text-2xs text-muted sm:w-40 sm:flex-none">{{ pool.label }}</span>
                        <!-- A pool at 0% still draws a sliver: an empty track is indistinguishable from a pool
                             this screen has no reading for, and those mean opposite things. -->
                        <div class="order-last h-1.5 min-w-0 flex-1 basis-full overflow-hidden rounded-full bg-content/10 sm:order-none sm:basis-0">
                            <div
                                class="h-full rounded-full bg-current"
                                :class="usageTone(pool.percent)"
                                :style="{ width: `${Math.max(pool.percent, 1)}%` }"
                            />
                        </div>
                        <span class="w-12 shrink-0 text-right text-2xs tabular-nums" :class="usageTone(pool.percent)">
                            {{ formatUtilization(pool.percent, row.stale) }}
                        </span>
                        <span class="shrink-0 truncate text-right text-2xs text-subtle sm:w-32">
                            {{ pool.resetsAt === undefined ? `` : `resets ${formatReset(pool.resetsAt)}` }}
                        </span>
                    </div>
                </div>
            </template>

            <!-- Large provider: the distribution, as bars. An account with no reading draws an EMPTY track and
                 never a zero-height bar — "0% used" and "we have no idea" are opposite claims, and the second
                 one is what is true. -->
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
                    <button type="button" class="cursor-pointer text-link hover:underline" @click="openRoster(group.provider)">View accounts</button>
                    <!-- Never a silent cap: a strip that shows 24 of 31 says so. -->
                    <span v-if="group.rows.length > MAX_BARS" class="text-subtle">
                        showing the {{ MAX_BARS }} most constrained of {{ group.rows.length }}
                    </span>
                </div>
            </template>
        </div>

        <!-- 3 · ATTENTION. Only what someone has to do something about. -->
        <div v-if="summary.attention.length > 0" class="flex flex-col gap-1.5 px-4 py-3">
            <span class="text-2xs font-medium text-content">Needs attention · {{ summary.attention.length }}</span>
            <div v-for="row in summary.attention" :key="row.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs">
                <ProviderLogo :provider="row.provider" class="shrink-0 self-center text-muted" />
                <span class="min-w-0 truncate text-muted">{{ row.label }}</span>
                <span :class="row.needsReauth ? `text-danger` : planLimitBandTone(`spent`)">
                    {{ row.needsReauth ? `sign-in expired — reconnect it on the Agent tab` : `${row.binding?.label ?? `plan`} spent` }}
                </span>
                <span v-if="!row.needsReauth && row.binding?.resetsAt !== undefined" class="text-subtle">
                    · reopens {{ formatReset(row.binding.resetsAt) }}
                </span>
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
                <input
                    v-if="rosterOpen"
                    v-model="rosterQuery"
                    type="search"
                    placeholder="Filter accounts…"
                    :class="cmp.input(`ml-auto h-7 w-full text-2xs sm:w-56`)"
                />
            </div>

            <div v-if="rosterOpen" class="scrollbar-thin overflow-x-auto">
                <table class="w-full text-2xs">
                    <thead class="text-left text-subtle">
                        <tr class="border-b border-line">
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
                            <td class="max-w-56 truncate py-1.5 pr-3 text-content">{{ row.label }}</td>
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
                <p v-if="roster.length === 0" :class="cmp.emptyState(`py-4`)">No account matches that filter.</p>
            </div>
        </div>

        <!-- The caveat sits INSIDE the surface, as the last row: a footnote floating below the border is read
             after the numbers it qualifies, if at all. Two readers, one caveat: Claude's pools come off the turn
             that just ended, so an idle sandbox's reading is as old as its last turn, and the routed
             subscriptions' are pulled on the daemon's own cadence. Either way the pools keep draining
             elsewhere — which is the entire distance between "1%" here and 98% in a terminal on the same
             account. -->
        <p class="px-4 py-2.5 text-2xs text-subtle">
            Read from your plan — Claude's when a turn finishes, ChatGPT's, Google's and Kimi's pulled in the background — so a number here can only
            ever be a floor: usage never falls inside a window, and other clients on the account spend the same pools without telling this sandbox.
        </p>
    </RowGroup>

    <!-- An unread state is not an empty one: until the connection read lands, this says nothing rather than
         claiming the sandbox has no accounts and taking it back a moment later. -->
    <p v-else :class="cmp.emptyState()">
        {{
            accountsLoaded
                ? `No AI account is connected yet — connect one on the Agent tab and its plan limits appear here.`
                : `Reading your connections…`
        }}
    </p>
</template>
