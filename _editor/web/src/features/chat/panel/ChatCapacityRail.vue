<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import { CAPACITY_RAIL_PX, type CapacityLane, type CapacityProvider, type CapacityRow, chatCapacity } from "./chatCapacity";
import { accountsLoaded } from "../accounts/providerAccounts";
import { formatAge, formatReset, formatUtilization, usageTone } from "../session/usageStatus";
import { refreshConnections } from "../accounts/useChat-accounts";
import { uiLength } from "../../../shell/window/uiScale";
import ProviderLogo from "../accounts/ProviderLogo.vue";

// What you can run the next task on, in the chat window's spare width — a readout, not a control (only the age is
// pressable, to re-measure). It doesn't average, rank models, or link the ledger; the full picture lives in
// composables/chat/chatCapacity.ts and the Usage tab.

// Refreshes on mount: pools are account-wide, shared across apps, so a stale window shows stale numbers.
onMounted(() => void refreshConnections());

const capacity = computed(() => chatCapacity());

// A routed pool names its reading, not an address (no choice to make); a lone account is already named by its
// heading; unmeasured names the kind of nothing. "most room" only appears where room was actually measured.
const rowName = (row: CapacityRow, entry: CapacityProvider): string | undefined =>
    row.label ?? (entry.pooled && row.percent !== undefined ? `most room` : row.lanes.length === 0 ? row.note : undefined);

// Full row as one sentence (hover + screen reader): every lane in drawn order, reset in parentheses per lane.
// Provider name omitted — already said by the heading above.
const laneDetail = (lane: CapacityLane, row: CapacityRow): string =>
    `${lane.label} ${formatUtilization(lane.percent, row.stale)}${lane.resetsAt === undefined ? `` : ` (resets ${formatReset(lane.resetsAt)})`}`;

const rowDetail = (row: CapacityRow, entry: CapacityProvider): string =>
    [
        row.label,
        row.identity,
        // Same rule as the drawn line: a comparison nothing was measured for must not appear in either medium.
        entry.pooled && row.percent !== undefined ? `most room of ${entry.ready}` : undefined,
        ...(row.lanes.length === 0 ? [row.note] : row.lanes.map((lane) => laneDetail(lane, row))),
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

// Both what holds a provider back and when waiting fixes it: a bare timestamp says nothing about what happens
// then, and a bare "spent" leaves the real question unanswered.
const outNote = (entry: { readonly reason: string; readonly reopensAt: number | undefined }): string =>
    entry.reopensAt === undefined ? entry.reason : `${entry.reason} · ${formatReset(entry.reopensAt)}`;

const countDetail = (entry: CapacityProvider): string =>
    `${entry.ready} of ${entry.total} accounts have room${entry.pooled ? `, and turns are spread across them automatically` : ``}`;

// One control for age and re-measure: the age itself is the pressable label, so watching it reset is the
// confirmation. Forced past the daemon's one-minute cache, since pressing this means asking about right now.
const measuring = ref(false);
const remeasure = async (): Promise<void> => {
    measuring.value = true;
    try {
        await refreshConnections(true);
    } finally {
        measuring.value = false;
    }
};
const remeasureLabel = computed(() =>
    capacity.value.measuredAt === undefined ? `Measure plan limits` : `Re-measure plan limits, measured ${formatAge(capacity.value.measuredAt)}`,
);
</script>

<template>
    <!--
        No surface of its own: whitespace and the heading mark it as a region, not a panel with a border or fill.
        Lifted
        out of flow rather than taking flex width, so the transcript keeps the full pane and its scrollbar the true
        edge; sits one bar in from that edge so it doesn't sit over the scrollbar strip.
    -->
    <aside
        class="absolute inset-y-0 z-10 flex min-h-0 flex-col"
        :style="{ width: uiLength(CAPACITY_RAIL_PX), right: `var(--chat-scrollbar)` }"
        aria-label="Plan headroom"
    >
        <!--
            The header names the question this column answers, not the data ("Plan limits" is the Usage tab's heading);
            age
            sits beside it.
        -->
        <div class="flex shrink-0 items-center gap-2 px-3 py-2">
            <span class="min-w-0 flex-1 truncate text-2xs font-medium uppercase tracking-wide text-muted">Ready to run</span>
            <button
                type="button"
                :class="ui.textAction(`gap-1 text-2xs text-subtle`)"
                :disabled="measuring"
                v-tooltip.left="`Re-measure every account's plan limits now`"
                :aria-label="remeasureLabel"
                @click="remeasure"
            >
                <Icon name="refresh" class="text-[0.6rem]" :spin="measuring" />
                <span v-if="capacity.measuredAt !== undefined">{{ formatAge(capacity.measuredAt) }}</span>
            </button>
        </div>

        <!--
            Unread isn't empty: until accounts load, this must not claim the fleet has nothing — drawn as the shape
            that's
            coming, not stated in words.
        -->
        <div v-if="!accountsLoaded" class="flex min-h-0 flex-1 flex-col gap-4 px-3 py-1" role="status" aria-busy="true">
            <span class="sr-only">Reading your connections…</span>
            <div v-for="index in 3" :key="index" class="flex flex-col gap-1.5" aria-hidden="true">
                <span class="skeleton block h-2.5 w-24" />
                <span class="skeleton block h-1 w-full rounded-full" />
            </div>
        </div>

        <template v-else>
            <!--
                Gap widens with nesting depth (lane < account < provider); it must grow with lane count or multi-bar
                accounts
                read as one long ladder.
            -->
            <div class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
                <!--
                    Every provider spent at once is an ordinary end-of-week state, not an error, so it's stated
                    plainly.
                -->
                <p v-if="capacity.providers.length === 0" class="text-2xs text-muted">Nothing has room right now.</p>

                <!--
                    One block per provider: the provider is the reader's actual choice here (accounts within it balance
                    automatically). No card per provider — the column draws no surface, so a border would be the only
                    box on screen.
                -->
                <div v-for="entry in capacity.providers" :key="entry.provider" class="flex flex-col gap-2.5">
                    <div class="flex items-center gap-1.5">
                        <ProviderLogo :provider="entry.provider" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ entry.label }}</span>
                        <!--
                            Count, never a mean: 30 idle plus one spent isn't "3% used", it's one account you can't
                            use. Hidden for a lone
                            account.
                        -->
                        <span
                            v-if="entry.total > 1"
                            class="shrink-0 text-2xs tabular-nums text-subtle"
                            v-tooltip.left="countDetail(entry)"
                            :aria-label="countDetail(entry)"
                            >{{ entry.ready }}/{{ entry.total }}</span
                        >
                    </div>

                    <!--
                        One lane per allowance (the 5-hour session and the week run out separately; one tightest-of-two
                        bar couldn't say
                        which). Pool names shrink to their window length ("5h", "wk") so two bars need no legend. A
                        grid keeps columns
                        aligned so same-window rows compare directly; the label column is content-sized so a longer
                        scope only costs
                        bar width.
                    -->
                    <!--
                        Drawn row is decoration, the sentence below is the content (same split as UsageRing): a bar
                        means nothing to a
                        screen reader, so the row is aria-hidden and the full sentence spoken once, not both halves.
                    -->
                    <div v-for="row in entry.rows" :key="row.id" class="flex flex-col gap-1" v-tooltip.left="rowDetail(row, entry)">
                        <div class="grid grid-cols-[auto_minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-1" aria-hidden="true">
                            <span
                                v-if="rowName(row, entry) !== undefined"
                                class="col-span-3 min-w-0 truncate text-2xs"
                                :class="row.label === undefined ? `text-subtle` : `text-muted`"
                            >
                                {{ rowName(row, entry) }}
                            </span>

                            <template v-for="lane in row.lanes" :key="lane.kind">
                                <!--
                                    Below the account name, not beside it at the same size: this is the little chart's
                                    axis, not another name.
                                -->
                                <span class="max-w-18 truncate text-3xs text-subtle">
                                    {{ lane.short }}<span v-if="lane.scope !== undefined">&nbsp;·&nbsp;{{ lane.scope }}</span>
                                </span>
                                <!--
                                    A pool at 0% still draws a sliver (min 1%), since an empty track reads as "no
                                    reading" — the opposite meaning. A
                                    row with genuinely no reading draws no lane and says so in words.
                                -->
                                <span class="block h-1 overflow-hidden rounded-full bg-content/10">
                                    <span
                                        class="block h-full rounded-full bg-current"
                                        :class="usageTone(lane.percent)"
                                        :style="{ width: `${Math.max(lane.percent, 1)}%` }"
                                    />
                                </span>
                                <span class="text-right text-2xs font-medium tabular-nums" :class="usageTone(lane.percent)">
                                    {{ formatUtilization(lane.percent, row.stale) }}
                                </span>
                            </template>

                            <!--
                                Shown only when the line above isn't already saying it (an unread account states "no
                                reading yet" once, not
                                twice).
                            -->
                            <span v-if="row.lanes.length === 0 && rowName(row, entry) !== row.note" class="col-span-3 text-2xs text-subtle">
                                {{ row.note }}
                            </span>
                        </div>
                        <span class="sr-only">{{ rowDetail(row, entry) }}</span>
                    </div>

                    <!-- Never a silent cap: a partial list still says how many more have room. -->
                    <span v-if="entry.hidden > 0" class="text-2xs text-subtle">+{{ entry.hidden }} more with room</span>
                </div>

                <!--
                    Without this, an absent provider could mean spent-until-Sunday or never-connected, with no way to
                    tell apart
                    short of leaving the window; each line says which. In flow under the offers, not pinned to the
                    bottom, since
                    this rail is opened to find what IS available.
                -->
                <div v-if="capacity.out.length > 0 || capacity.needsReauth > 0" class="flex flex-col gap-1 border-t border-line pt-3">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Unavailable</span>
                    <div v-for="entry in capacity.out" :key="entry.provider" class="flex items-baseline gap-2" v-tooltip.left="entry.detail">
                        <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ entry.label }}</span>
                        <span class="shrink-0 text-2xs text-subtle">{{ outNote(entry) }}</span>
                    </div>
                    <!--
                        Counted, not listed: a dead credential is the one state that stays broken until a person acts,
                        so it earns its
                        own line.
                    -->
                    <!--
                        The condition is the alarm; the instruction stays quiet beside it (as in the Usage tab's
                        attention block), so
                        the sentence doesn't shout twice.
                    -->
                    <p v-if="capacity.needsReauth > 0" class="text-2xs">
                        <span class="text-warning">{{ capacity.needsReauth }} sign-in{{ capacity.needsReauth === 1 ? `` : `s` }} expired</span>
                        <span class="text-subtle"> · reconnect on the Agent tab</span>
                    </p>
                </div>
            </div>
        </template>
    </aside>
</template>
