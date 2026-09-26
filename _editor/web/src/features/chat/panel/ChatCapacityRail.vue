<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import { type CapacityBlocked, type CapacityLane, type CapacityProvider, type CapacityRow, type CapacityUnread, chatCapacity, heldReadings } from "./chatCapacity";
import { accountsLoaded } from "../accounts/providerAccounts";
import { formatAge, formatRemaining, formatReset, meterFill, meterTint, meterTrack, remainingFigure, usageTone } from "../session/usageStatus";
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

// How long until an allowance refills; undefined when unmeasured or already past. A spent lane keeps it: when it
// comes back is the one thing left worth saying about it.
const laneReset = (lane: CapacityLane, now: number = Date.now()): string | undefined => {
    if (lane.resetsAt === undefined) {
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
    `${lane.label} ${formatRemaining(lane.percent, row.stale)}${lane.resetsAt === undefined ? `` : ` (resets ${formatReset(lane.resetsAt)})`}`;

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

// Readings a re-read could not reach: the provider holding reads off, or refusing them ("Verify your account to
// continue"). Worth knowing, since the age above leaves them out and their bars are older than it says, but not worth
// the column's height: this rail is not where accounts are fixed. So the drawn form is one quiet icon and a count
// beside the age, and every sentence rides the hover and the screen reader.
const staleNote = computed((): { readonly count: number; readonly detail: string } | undefined => {
    const held = heldReadings(heldAccounts.value);
    const lines = [
        ...(held === undefined
            ? []
            : [`Can't re-read ${held.labels.length === held.count ? held.labels.join(`, `) : plural(held.count)} yet, retry ${formatReset(held.resumesAt)}`]),
        ...capacity.value.unread.map((entry: CapacityUnread) =>
            [
                `Can't re-read ${entry.count <= 2 && entry.labels.length === entry.count ? entry.labels.join(`, `) : plural(entry.count)}`,
                entry.reason.replace(/\.$/, ``),
                ...(entry.lastReadAt === undefined ? [] : [`last read ${formatAge(entry.lastReadAt)}`]),
            ].join(` · `),
        ),
    ];
    const count = (held?.count ?? 0) + capacity.value.unread.reduce((sum, entry) => sum + entry.count, 0);
    return lines.length === 0 ? undefined : { count, detail: lines.join(`. `) };
});

const plural = (count: number): string => `${count} ${count === 1 ? `account` : `accounts`}`;

// Everything the one-line blocked row leaves out: which accounts, what each provider said, and who can fix it.
const blockedDetail = (entry: CapacityBlocked): string =>
    [
        ...entry.labels,
        entry.fix === `reconnect` ? t(`chat.chatCapacityRail.reconnectOnAgentTab`) : entry.fix === `admin` ? t(`chat.chatCapacityRail.seatFromAdmin`) : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
</script>

<template>
    <!-- No surface of its own: whitespace and the heading mark it as a region, not a panel with a border or fill. -->
    <!-- Placed and sized by ChatSideRail, which owns the strip this shares with the chat's checklist. -->
    <section class="flex min-h-0 flex-1 flex-col" :aria-label="t(`chat.chatCapacityRail.planHeadroom`)">
        <!-- The refresh control stays at the edge; the heading beside it names what the figures are. -->
        <div class="flex shrink-0 items-center justify-end gap-2 px-3 py-2">
            <!-- Says once what every figure below is, in the row the refresh control already takes, so it costs no height:
                 the lanes then carry bare figures, and a word repeated on every lane was width taken from the bars. -->
            <span v-if="measuredProviders.length > 0" class="mr-auto min-w-0 truncate text-2xs font-medium uppercase tracking-wide text-subtle">{{
                t(`chat.chatCapacityRail.allowanceLeft`)
            }}</span>
            <!-- Readings the age leaves out: a quiet mark by the number it qualifies, the reasons on hover. -->
            <span v-if="staleNote !== undefined" v-tooltip.left="staleNote.detail" class="flex shrink-0 items-center gap-0.5 text-2xs text-warning">
                <Icon name="exclamation-circle" class="text-[0.6rem]" />
                <span class="tabular-nums" aria-hidden="true">{{ staleNote.count }}</span>
                <span class="sr-only">{{ staleNote.detail }}</span>
            </span>
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

        <!-- Unread isn't empty: until accounts load, this must not claim the fleet has nothing — drawn as the shape that's coming, not stated in words. -->
        <div v-if="!accountsLoaded" class="flex min-h-0 flex-1 flex-col gap-4 px-3 py-1" role="status" aria-busy="true">
            <span class="sr-only">{{ t(`sandbox.words.readingConnections`) }}</span>
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
                                <!-- Drains as turns spend it: the fill is what is left. A spent pool draws no fill and tints its
                                     track instead, since an empty neutral track reads as "no reading". -->
                                <span class="block h-1 overflow-hidden rounded-full" :class="meterTrack(lane.percent)">
                                    <span
                                        class="ui-meter-fill block h-full rounded-full"
                                        :class="usageTone(lane.percent)"
                                        :style="{ width: `${meterFill(lane.percent)}%`, ...meterTint(lane.percent) }"
                                    />
                                </span>
                                <div class="flex items-baseline justify-end gap-1 whitespace-nowrap text-right">
                                    <span class="text-2xs font-medium tabular-nums" :class="usageTone(lane.percent)" :style="meterTint(lane.percent)">
                                        {{ remainingFigure(lane.percent, row.stale) }}
                                    </span>
                                    <span v-if="laneReset(lane)" class="text-3xs text-subtle">·&nbsp;{{ laneReset(lane) }}</span>
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
                    <!-- Counted, not listed, one line per condition, shaped like the rows above it. Which accounts, the provider's
                         own words and the fix ride the hover: this rail says what can't run, the Agent tab is where it's fixed. -->
                    <div v-for="entry in capacity.blocked" :key="entry.fix" v-tooltip.left="blockedDetail(entry)">
                        <div class="flex items-baseline gap-2" aria-hidden="true">
                            <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ t(`chat.chatCapacityRail.cantServe`, { count: entry.count }) }}</span>
                            <span class="shrink-0 text-2xs text-warning">{{ entry.reason }}</span>
                        </div>
                        <span class="sr-only">{{ t(`chat.chatCapacityRail.cantServe`, { count: entry.count }) }} · {{ entry.reason }} · {{ blockedDetail(entry) }}</span>
                    </div>
                </div>
            </div>
        </template>
    </section>
</template>
