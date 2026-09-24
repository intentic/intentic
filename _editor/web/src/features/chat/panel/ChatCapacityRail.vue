<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import { SPENT_UTILIZATION } from "@intentic/sandbox-contract";
import { type CapacityLane, type CapacityProvider, type CapacityRow, chatCapacity, heldReadings } from "./chatCapacity";
import { accountsLoaded } from "../accounts/providerAccounts";
import { formatAge, formatReset, formatUtilization, usageTone } from "../session/usageStatus";
import { heldAccounts, refreshConnections } from "../accounts/useChat-accounts";
import ProviderLogo from "../accounts/ProviderLogo.vue";
import { useT } from "@intentic/ui/i18n";

// Headroom rail in chat pop-out: displays runnable provider capacity without full Usage tab reconciliation.

// Refreshes on mount: pools are account-wide, shared across apps, so a stale window shows stale numbers.
const t = useT();

onMounted(() => void refreshConnections());

// Held accounts ride in so the age below counts only what a press could actually move; the line under it says the rest.
const capacity = computed(() => chatCapacity(heldAccounts.value));

const measuredProviders = computed(() => capacity.value.providers.filter((entry) => entry.rows.some((row) => row.lanes.length > 0)));

const unmeasuredProviders = computed(() => capacity.value.providers.filter((entry) => entry.rows.every((row) => row.lanes.length === 0)));

// How long until an unexhausted allowance resets; undefined when unmeasured, spent, or in the past.
const laneReset = (lane: CapacityLane, now: number = Date.now()): string | undefined => {
    if (lane.resetsAt === undefined || lane.percent >= SPENT_UTILIZATION) {
        return undefined;
    }
    const diffMs = lane.resetsAt * 1000 - now;
    if (diffMs <= 0) {
        return undefined;
    }
    const diffMinutes = Math.ceil(diffMs / 60_000);
    if (diffMinutes < 60) {
        return `in ${diffMinutes}m`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    const remMinutes = diffMinutes % 60;
    if (diffHours < 24) {
        return remMinutes > 0 ? `in ${diffHours}h ${remMinutes}m` : `in ${diffHours}h`;
    }
    const diffDays = Math.floor(diffMinutes / (24 * 60));
    const remHours = Math.floor((diffMinutes % (24 * 60)) / 60);
    if (diffDays < 2 && remHours > 0) {
        return `in 1d ${remHours}h`;
    }
    return `in ${diffDays}d`;
};

// Full row as one sentence (hover + screen reader): every lane in drawn order, reset in parentheses per lane.
// Provider name omitted — already said by the heading above.
const laneDetail = (lane: CapacityLane, row: CapacityRow): string =>
    `${lane.label} ${formatUtilization(lane.percent, row.stale)}${lane.resetsAt === undefined ? `` : ` (resets ${formatReset(lane.resetsAt)})`}`;

const rowDetail = (row: CapacityRow, entry: CapacityProvider): string =>
    [row.label, row.identity, ...(row.lanes.length === 0 ? [row.note] : row.lanes.map((lane) => laneDetail(lane, row)))]
        .filter((part) => part !== undefined)
        .join(` · `);

// Both what holds a provider back and when waiting fixes it: a bare timestamp says nothing about what happens
// then, and a bare "spent" leaves the real question unanswered.
const outNote = (entry: { readonly reason: string; readonly reopensAt: number | undefined }): string =>
    entry.reopensAt === undefined ? entry.reason : `${entry.reason} · ${formatReset(entry.reopensAt)}`;

// Says what the ratio counts, which is the only place a credential held out of it is accounted for on this line.
const countDetail = (entry: CapacityProvider): string =>
    [
        `${entry.ready} of ${entry.total} accounts have room`,
        ...(entry.blocked === 0 ? [] : [`${entry.blocked} more can't serve a turn at all`]),
        ...(entry.pooled ? [`turns are spread across them automatically`] : []),
    ].join(` · `);

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
    capacity.value.measuredAt === undefined
        ? `Measure plan limits`
        : `Re-measure plan limits, oldest reading ${formatAge(capacity.value.measuredAt)}`,
);

// What the last press could not read: while the provider holds a read off, the oldest age below cannot move however
// often the button is pressed. Says re-read, never "rate-limited", which on a panel of plan limits would read as the
// allowance itself being spent.
const heldNote = computed((): { readonly subject: string; readonly retry: string } | undefined => {
    const entry = heldReadings(heldAccounts.value);
    if (entry === undefined) {
        return undefined;
    }
    const names = entry.labels.length === entry.count ? entry.labels.join(`, `) : `${entry.count} ${entry.count === 1 ? `account` : `accounts`}`;
    return { subject: `Can't re-read ${names} yet`, retry: `retry ${formatReset(entry.resumesAt)}` };
});
</script>

<template>
    <!-- No surface of its own: whitespace and the heading mark it as a region, not a panel with a border or fill. -->
    <!-- Placed and sized by ChatSideRail, which owns the strip this shares with the chat's checklist. -->
    <section class="flex min-h-0 flex-1 flex-col" :aria-label="t(`chat.chatCapacityRail.planHeadroom`)">
        <!-- The refresh control stays at the edge because the rail has no heading text. -->
        <div class="flex shrink-0 items-center justify-end gap-2 px-3 py-2">
            <button
                type="button"
                :class="ui.textAction(`gap-1 text-2xs text-subtle`)"
                :disabled="measuring"
                :aria-label="remeasureLabel"
                @click="remeasure"
            >
                <Icon name="refresh" class="text-[0.6rem]" :spin="measuring" />
                <span v-if="capacity.measuredAt !== undefined">{{ formatAge(capacity.measuredAt) }}</span>
            </button>
        </div>

        <!-- Sits with the control it explains: the age above is the oldest reading here, so one account held off pins it. -->
        <p v-if="heldNote !== undefined" class="shrink-0 px-3 pb-2 text-2xs">
            <span class="text-warning">{{ heldNote.subject }}</span>
            <span class="text-subtle"> · {{ heldNote.retry }}</span>
        </p>

        <!-- Unread isn't empty: until accounts load, this must not claim the fleet has nothing — drawn as the shape that's coming, not stated in words. -->
        <div v-if="!accountsLoaded" class="flex min-h-0 flex-1 flex-col gap-4 px-3 py-1" role="status" aria-busy="true">
            <span class="sr-only">{{ t(`shared.readingConnections`) }}</span>
            <div v-for="index in 3" :key="index" class="flex flex-col gap-1.5" aria-hidden="true">
                <span class="skeleton block h-2.5 w-24" />
                <span class="skeleton block h-1 w-full rounded-full" />
            </div>
        </div>

        <template v-else>
            <!-- Gap widens with nesting depth (lane < account < provider); it must grow with lane count or multi-bar accounts read as one long ladder. -->
            <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
                <!-- Every provider spent at once is an ordinary end-of-week state, not an error, so it's stated plainly. -->
                <p v-if="capacity.providers.length === 0" class="text-2xs text-muted">{{ t(`chat.chatCapacityRail.nothingRoomRightNow`) }}</p>

                <!-- One block per provider: the provider is the reader's actual choice here (accounts within it balance automatically). -->
                <div v-for="entry in measuredProviders" :key="entry.provider" class="flex flex-col gap-2.5">
                    <div class="flex items-center gap-1.5">
                        <ProviderLogo :provider="entry.provider" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ entry.label }}</span>
                        <!-- Count, never a mean: 30 idle plus one spent isn't "3% used", it's one account you can't use. -->
                        <span v-if="entry.total > 1" class="shrink-0 text-2xs tabular-nums text-subtle" :aria-label="countDetail(entry)"
                            >{{ entry.ready }}/{{ entry.total }}</span
                        >
                    </div>

                    <!-- One lane per allowance (the 5-hour session and the week run out separately; one tightest-of-two bar couldn't say which). -->
                    <!-- Drawn row is decoration, the sentence below is the content (same split as UsageRing): a bar means nothing to a screen reader. -->
                    <div v-for="row in entry.rows" :key="row.id" class="flex flex-col gap-1">
                        <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1" aria-hidden="true">
                            <span v-if="row.label !== undefined" class="col-span-3 min-w-0 truncate text-2xs text-muted">
                                {{ row.label }}
                            </span>

                            <template v-for="lane in row.lanes" :key="lane.kind">
                                <!-- Below the account name, not beside it at the same size: this is the little chart's axis, not another name. -->
                                <span class="max-w-18 truncate text-3xs text-subtle">
                                    {{ lane.short }}<span v-if="lane.scope !== undefined">&nbsp;·&nbsp;{{ lane.scope }}</span>
                                </span>
                                <!-- A pool at 0% still draws a sliver (min 1%), since an empty track reads as "no reading" — the opposite meaning. -->
                                <span class="block h-1 overflow-hidden rounded-full bg-content/10">
                                    <span
                                        class="ui-meter-fill block h-full rounded-full"
                                        :class="usageTone(lane.percent)"
                                        :style="{ width: `${Math.max(lane.percent, 1)}%` }"
                                    />
                                </span>
                                <div class="flex items-baseline justify-end gap-1 text-right">
                                    <span class="text-right text-2xs font-medium tabular-nums" :class="usageTone(lane.percent)">
                                        {{ formatUtilization(lane.percent, row.stale) }}
                                    </span>
                                    <span v-if="laneReset(lane)" class="text-3xs text-subtle font-normal whitespace-nowrap">
                                        ·&nbsp;{{ laneReset(lane) }}
                                    </span>
                                </div>
                            </template>

                            <span v-if="row.lanes.length === 0" class="col-span-3 text-2xs text-subtle">
                                {{ row.note }}
                            </span>
                        </div>
                        <span class="sr-only">{{ rowDetail(row, entry) }}</span>
                    </div>

                    <!-- Never a silent cap: a partial list still says how many more have room. -->
                    <span v-if="entry.hidden > 0" class="text-2xs text-subtle">{{
                        t(`chat.chatCapacityRail.moreRoom`, { hidden: entry.hidden })
                    }}</span>
                </div>

                <!-- Unmeasured providers collapsed to title row and grouped together -->
                <div v-if="unmeasuredProviders.length > 0" class="flex flex-col gap-1.5">
                    <div v-for="entry in unmeasuredProviders" :key="entry.provider">
                        <div class="flex items-center gap-1.5" aria-hidden="true">
                            <ProviderLogo :provider="entry.provider" class="shrink-0 text-2xs text-muted" />
                            <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ entry.label }}</span>
                            <span v-if="entry.total > 1" class="shrink-0 text-2xs tabular-nums text-subtle" :aria-label="countDetail(entry)"
                                >{{ entry.ready }}/{{ entry.total }}</span
                            >
                            <span class="shrink-0 text-2xs text-subtle">{{ entry.rows[0]?.note }}</span>
                        </div>
                        <span class="sr-only">{{ entry.rows[0] ? rowDetail(entry.rows[0], entry) : entry.label }}</span>
                        <span v-if="entry.hidden > 0" class="text-2xs text-subtle">{{
                            t(`chat.chatCapacityRail.moreRoom`, { hidden: entry.hidden })
                        }}</span>
                    </div>
                </div>

                <!-- Provider rows distinguish spent capacity from an unconnected provider. -->
                <div v-if="capacity.out.length > 0 || capacity.blocked.length > 0" class="flex flex-col gap-1 border-t border-line pt-3">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`chat.chatCapacityRail.unavailable`) }}</span>
                    <div v-for="entry in capacity.out" :key="entry.provider" class="flex items-baseline gap-2">
                        <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ entry.label }}</span>
                        <span class="shrink-0 text-2xs text-subtle">{{ outNote(entry) }}</span>
                    </div>
                    <!-- Counted, not listed, one line per condition: a credential that stays broken until a person acts is the one thing a fleet's percentages cannot say. -->
                    <!-- The condition is the alarm; the instruction stays quiet beside it (as in the Usage tab's attention block), so the sentence doesn't shout twice. -->
                    <p v-for="entry in capacity.blocked" :key="entry.reason" v-tooltip.left="entry.labels.join(`, `)" class="text-2xs">
                        <span class="text-warning">{{ t(`chat.chatCapacityRail.cantServe`, { count: entry.count }) }}</span>
                        <span class="text-subtle"> · {{ entry.reason }}</span>
                    </p>
                    <!-- One line per door, not per condition: every other condition is fixed by signing in again, a lost seat only by the organisation. -->
                    <p v-if="capacity.blocked.some((entry) => entry.reconnect)" class="text-2xs text-subtle">
                        {{ t(`chat.chatCapacityRail.reconnectOnAgentTab`) }}
                    </p>
                    <p v-if="capacity.blocked.some((entry) => !entry.reconnect)" class="text-2xs text-subtle">
                        {{ t(`chat.chatCapacityRail.seatFromAdmin`) }}
                    </p>
                </div>
            </div>
        </template>
    </section>
</template>
