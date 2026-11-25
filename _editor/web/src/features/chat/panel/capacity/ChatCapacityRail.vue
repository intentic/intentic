<script setup lang="ts">
import { useLoaded } from "@intentic/extension-api";
import { Await, SectionHeader, type Tip, type TipRow, ui } from "@intentic/ui";
import { useRowReveal } from "@intentic/ui/motion";
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import ChatCapacityLane from "./ChatCapacityLane.vue";
import {
    type CapacityBlocked,
    type CapacityLane,
    type CapacityMine,
    type CapacityProvider,
    type CapacityRow,
    type CapacityUnread,
    chatCapacity,
} from "./chatCapacity";
import { accountsLoaded } from "../../../../models/providers/providerAccounts";
import { formatAge, formatRemaining, formatReset, meterTint, remainingFigure, usageTone } from "../../../../models/providers/usageStatus";
import { verdictNow } from "../../../../models/providers/capacity/verdictClock";
import { heldAccounts, refreshConnections } from "../../../../models/conversations/accounts/useChat-accounts";
import { useRemeasure } from "../../accounts/pickerAccounts";
import ProviderLogo from "../../../../parts/providers/ProviderLogo.vue";
import { useT } from "@intentic/ui/i18n";
import { useRailMark } from "./railCarries";

// Headroom rail in chat pop-out: displays runnable provider capacity without full Usage tab reconciliation.

// Refreshes on mount: pools are account-wide, shared across apps, so a stale window shows stale numbers.
const t = useT();

// The chat this rail stands beside (ChatSideRail, or the board's corner beside it, Agents.vue): its account's row is
// marked as the reader's own.
// `fold`: what it stands under needs the height (the board's Finished lane scrolling past its window, cornerFit.ts), so
// it is drawn as one row until pressed.
const { mine, fold = false } = defineProps<{ mine?: CapacityMine | undefined; fold?: boolean }>();

onMounted(() => void refreshConnections());

// Held accounts ride in so the age below counts only what a press could actually move; the line under it says the rest.
// At the verdict clock, not a bare Date.now(): read once, that left a pool that reset drawn spent until some reading
// moved the rail (verdictClock.ts).
const capacity = computed(() => chatCapacity(heldAccounts.value, verdictNow(), mine));
// Unread isn't empty: until the accounts are read, the rail must not claim the fleet has nothing.
const reading = useLoaded(() => ({ data: accountsLoaded.value ? capacity.value : undefined, error: undefined, fetching: false, wanted: true }));

const measuredProviders = computed(() => capacity.value.providers.filter((entry) => entry.rows.some((row) => row.lanes.length > 0)));

const unmeasuredProviders = computed(() => capacity.value.providers.filter((entry) => entry.rows.every((row) => row.lanes.length === 0)));

// The marked row with figures on it, told to the panel, so the chat's own composer chip steps aside while this says it
// (railCarries.ts). A marked row with no lanes says nothing the chip would, so it is not reported.
const railMark = useRailMark();
watchEffect(() => {
    if (railMark !== undefined) {
        railMark.value = measuredProviders.value.flatMap((entry) => entry.rows).find((row) => row.mine && row.lanes.length > 0)?.id;
    }
});
onBeforeUnmount(() => {
    if (railMark !== undefined) {
        railMark.value = undefined;
    }
});

// FOLDED, IT IS ONE ROW: the heading and each provider's figure for its roomiest account, a spent provider at 0%, so
// "can I start one more" is still answered at a glance while the cards above it have the height. The press opens the
// whole column in the same place, and it folds again by its own chevron or the next time the cards above need the room.
// Nothing moves to another column: Usage left stays where the reader learned it is (2026-11-23).
const opened = ref(false);
watch(
    () => fold,
    () => {
        opened.value = false;
    },
);
const folded = computed(() => fold && !opened.value);
interface Glance {
    readonly provider: CapacityProvider["provider"];
    readonly label: string;
    readonly percent: number;
    readonly stale: boolean;
    readonly spent: boolean;
}
const glance = computed((): readonly Glance[] => [
    // The roomiest account's headline lane, the one the open column draws first under the provider, so folding and opening
    // never disagree. Not the row's `percent`: on a pooled provider it is the worst pool any account brought, which read
    // 0% for a provider still serving turns.
    ...measuredProviders.value.flatMap((entry) => {
        const row = entry.rows.find((candidate) => candidate.lanes.length > 0);
        const lead = row?.lanes[0];
        return row === undefined || lead === undefined
            ? []
            : [{ provider: entry.provider, label: entry.label, percent: lead.percent, stale: row.stale, spent: false }];
    }),
    ...capacity.value.out.map((entry) => ({ provider: entry.provider, label: entry.label, percent: 100, stale: false, spent: true })),
]);
const glanceLabel = computed(() =>
    [t(`chat.chatCapacityRail.allowanceLeft`), glance.value.map((item) => `${item.label} ${formatRemaining(item.percent, item.stale)}`).join(`, `)]
        .filter((part) => part !== ``)
        .join(`: `),
);

// "This chat" on the heading only when no row below carries it: on Auto, or a provider whose one row has no figures.
const headingMine = (entry: CapacityProvider): boolean => entry.mine && !entry.rows.some((row) => row.mine);

// THE READINGS REPLACE THEIR SKELETON ROW BY ROW, as the chat's checklist above it opens (ChatRailChecklist.vue,
// reveal.ts): each provider's heading, then its accounts, down the column, so it resolves in the order it is read
// instead of popping in whole, and a row a later re-read adds plays in on its own. Nothing slides: until 2026-11-23 a
// re-read's rows moved from where they had been drawn (a FLIP), which in the board's corner, laid out before its lane
// had a height, flew them in from the column's top-left.
const column = ref<HTMLElement>();
useRowReveal(column, {
    key: () =>
        [
            accountsLoaded.value,
            ...measuredProviders.value.flatMap((entry) => [entry.provider, ...entry.rows.map((row) => row.id)]),
            ...unmeasuredProviders.value.map((entry) => entry.provider),
            ...capacity.value.out.map((entry) => entry.provider),
            ...capacity.value.blocked.map((entry) => entry.fix),
        ].join(`,`),
    arrivals: true,
});

// Full row as one sentence (hover + screen reader): every lane in drawn order, reset in parentheses per lane.
// Provider name omitted — already said by the heading above.
// A nested lane says which allowance holds it, and that its room waits on that one when the holder is spent.
const laneDetail = (lane: CapacityLane, row: CapacityRow): string =>
    `${lane.label} ${formatRemaining(lane.percent, row.stale)}${
        lane.pace?.runsOutAt === undefined ? `` : `, ${t(`common.usageRing.runsOut`, { when: formatReset(lane.pace.runsOutAt) })}`
    }${
        lane.resetsAt === undefined ? `` : ` (${t(`chat.chatCapacityRail.resets`, { when: formatReset(lane.resetsAt) })})`
    }${
        lane.within === undefined
            ? ``
            : `, ${lane.capped ? t(`chat.chatCapacityRail.unusableUntil`, { name: lane.within }) : t(`chat.chatCapacityRail.within`, { name: lane.within })}`
    }`;

const rowDetail = (row: CapacityRow, entry: CapacityProvider): string =>
    [row.mine ? t(`chat.chatCapacityRail.thisChat`) : undefined, row.label, row.identity, ...(row.lanes.length === 0 ? [row.note] : row.lanes.map((lane) => laneDetail(lane, row)))]
        .filter((part) => part !== undefined)
        .join(` · `);

// Both what holds a provider back and when waiting fixes it: a bare timestamp says nothing about what happens
// then, and a bare "spent" leaves the real question unanswered.
const outNote = (entry: { readonly reason: string; readonly reopensAt: number | undefined }): string =>
    entry.reopensAt === undefined ? entry.reason : `${entry.reason} · ${formatReset(entry.reopensAt)}`;

// Says what the ratio counts, which is the only place a credential held out of it is accounted for on this line.
const countDetail = (entry: CapacityProvider): string =>
    [
        t(`chat.chatCapacityRail.accountsHaveRoom`, { ready: entry.ready, total: entry.total }),
        ...(entry.blocked === 0 ? [] : [t(`chat.chatCapacityRail.moreCantServe`, { count: entry.blocked })]),
        ...(entry.pooled ? [t(`chat.chatCapacityRail.turnsSpread`)] : []),
    ].join(` · `);

// One control for age and re-measure: the age itself is the pressable label, so watching it reset is the
// confirmation. Forced past the daemon's one-minute cache, since pressing this means asking about right now; the same
// press as the picker's, so a read either started is still turning here.
const { measuring, remeasure } = useRemeasure();
const remeasureLabel = computed(() =>
    capacity.value.measuredAt === undefined
        ? t(`chat.pickerAccounts.measurePlanLimits`)
        : t(`chat.chatCapacityRail.remeasureOldest`, { age: formatAge(capacity.value.measuredAt) }),
);

// Readings a re-read could not reach: the provider holding reads off, or refusing them ("Verify your account to
// continue"). Worth knowing, since the age above leaves them out and their bars are older than it says, but not worth
// the column's height: this rail is not where accounts are fixed. So the drawn form is one quiet icon and a count
// beside the age, and every sentence rides the hover and the screen reader.
const staleNote = computed((): { readonly count: number; readonly detail: string } | undefined => {
    const { held } = capacity.value;
    const lines = [
        ...(held === undefined
            ? []
            : [
                  t(`chat.chatCapacityRail.cantReReadYet`, {
                      who: held.labels.length === held.count ? held.labels.join(`, `) : plural(held.count),
                      when: formatReset(held.resumesAt),
                  }),
              ]),
        ...capacity.value.unread.map((entry: CapacityUnread) =>
            [
                t(`chat.chatCapacityRail.cantReRead`, {
                    who: entry.count <= 2 && entry.labels.length === entry.count ? entry.labels.join(`, `) : plural(entry.count),
                }),
                entry.reason.replace(/\.$/, ``),
                ...(entry.lastReadAt === undefined ? [] : [t(`chat.chatCapacityRail.lastReadAge`, { age: formatAge(entry.lastReadAt) })]),
            ].join(` · `),
        ),
    ];
    const count = (held?.count ?? 0) + capacity.value.unread.reduce((sum, entry) => sum + entry.count, 0);
    return lines.length === 0 ? undefined : { count, detail: lines.join(`. `) };
});

const plural = (count: number): string => t(`chat.chatCapacityRail.accountCount`, { count }, count);

// The account badge's hover: accounts with room the column draws no row for, or, on a provider with nothing to measure,
// every one its one line stands for.
const moreTip = (count: number): Tip => ({ title: t(`chat.chatCapacityRail.moreAccounts`, { count }, count), note: t(`chat.chatCapacityRail.withRoom`) });
const roomTip = (count: number): Tip => ({ title: plural(count), note: t(`chat.chatCapacityRail.withRoom`) });

// Who a row of the hover card means: the names while there are few enough to read, else how many.
const whoOf = (labels: readonly string[], count: number): string | number => (labels.length === count && count <= 2 ? labels.join(`, `) : count);

// The hover's card: how many readings are stuck and why, and how old they are; the sentence stays the screen reader's.
const staleTip = computed((): Tip | undefined => {
    if (staleNote.value === undefined) {
        return undefined;
    }
    const { held } = capacity.value;
    const unread = capacity.value.unread;
    const refused = unread.reduce((sum, entry) => sum + entry.count, 0);
    const lastReads = unread.flatMap((entry) => (entry.lastReadAt === undefined ? [] : [entry.lastReadAt]));
    const rows: TipRow[] = [
        ...(held === undefined
            ? []
            : [
                  { label: t(`chat.chatCapacityRail.rateLimited`), value: whoOf(held.labels, held.count) },
                  { label: t(`chat.chatCapacityRail.retry`), value: formatReset(held.resumesAt) },
              ]),
        ...(refused === 0
            ? []
            : [
                  {
                      label: t(`chat.chatCapacityRail.refused`),
                      value: whoOf(
                          unread.flatMap((entry) => entry.labels),
                          refused,
                      ),
                  },
                  { label: t(`chat.chatCapacityRail.lastRead`), value: lastReads.length === 0 ? `` : formatAge(Math.min(...lastReads)) },
              ]),
    ];
    return { title: t(`chat.chatCapacityRail.notReRead`), tone: `warning`, rows };
});

// Everything the one-line blocked row leaves out: which accounts, what each provider said, and who can fix it.
const fixWhere = (entry: CapacityBlocked): string | undefined =>
    entry.fix === `reconnect`
        ? t(`chat.chatCapacityRail.reconnectOnAgentTab`)
        : entry.fix === `verify`
          ? t(`chat.chatCapacityRail.verifyOnAgentTab`)
          : entry.fix === `admin`
            ? t(`chat.chatCapacityRail.seatFromAdmin`)
            : undefined;
const blockedDetail = (entry: CapacityBlocked): string =>
    [...entry.labels, fixWhere(entry)].filter((part) => part !== undefined).join(` · `);

// The same as a hover card: the fix as its headline, where it is made, and which accounts.
const blockedTip = (entry: CapacityBlocked): Tip => {
    const note = entry.fix === `reconnect` || entry.fix === `verify` ? t(`chat.chatCapacityRail.onAgentTab`) : undefined;
    const title =
        entry.fix === `reconnect`
            ? t(`ui.action.reconnect`)
            : entry.fix === `verify`
              ? t(`chat.chatCapacityRail.fixVerify`)
              : entry.fix === `admin`
                ? t(`chat.chatCapacityRail.fixAdmin`)
                : t(`chat.chatCapacityRail.fixWait`);
    const names = entry.names.length <= 3 ? entry.names.join(`, `) : entry.count;
    return { title, tone: `warning`, rows: [{ label: t(`chat.chatCapacityRail.accounts`), value: names }], note };
};
// WHAT HAS NO BAR RIDES ONE MARK BESIDE THE HEADING: providers with nothing to measure, providers spent outright and
// credentials that can't serve each took a line of the column under the bars, a line per fact the reader rarely acts on
// here. Since 2026-11-25 they are one icon by "Usage left" with every line on its hover card (and its sentences the
// screen reader's), so the column is only bars. With no bars at all the lines ARE the column, so they stay drawn.
const asideInline = computed(() => measuredProviders.value.length === 0);
const hasAside = computed(() => unmeasuredProviders.value.length > 0 || capacity.value.out.length > 0 || capacity.value.blocked.length > 0);
const thisChat = (label: string, isMine: boolean): string => (isMine ? `${label} · ${t(`chat.chatCapacityRail.thisChat`)}` : label);
const asideTip = computed((): Tip => {
    const { out, blocked } = capacity.value;
    const fixes = [...new Set(blocked.flatMap((entry) => fixWhere(entry) ?? []))];
    return {
        title: out.length > 0 || blocked.length > 0 ? t(`chat.chatCapacityRail.unavailable`) : t(`chat.chatCapacityRail.otherProviders`),
        tone: out.length > 0 || blocked.length > 0 ? `warning` : undefined,
        rows: [
            ...unmeasuredProviders.value.map((entry) => ({
                label: thisChat(entry.label, entry.mine),
                value: [entry.rows[0]?.note, entry.ready > 1 ? plural(entry.ready) : undefined].filter((part) => part !== undefined).join(` · `),
            })),
            ...out.map((entry) => ({ label: thisChat(entry.label, entry.mine), value: outNote(entry), tone: `warning` as const })),
            ...blocked.map((entry) => ({
                label: t(`chat.chatCapacityRail.cantServe`, { count: entry.count }),
                value: entry.reason,
                tone: `warning` as const,
            })),
        ],
        note: fixes.length === 0 ? undefined : fixes.join(` · `),
    };
});
// The card as one sentence for the screen reader, with which accounts can't serve, which the card only counts.
const asideSpoken = computed(() =>
    [
        asideTip.value.title,
        ...(asideTip.value.rows ?? []).map((row) => `${row.label} · ${row.value}`),
        ...capacity.value.blocked.map((entry) => entry.labels.join(` · `)),
        asideTip.value.note,
    ]
        .filter((part) => part !== undefined && part !== ``)
        .join(`. `),
);
// The mark's own ink: warning while anything on the card can't run (spent included: waiting fixes it, so not danger),
// quiet when it only lists providers that publish no limits. Pulled in past the header's gap so it reads as the label's.
const asideIcon = computed(() =>
    capacity.value.out.length > 0 || capacity.value.blocked.length > 0
        ? ({ name: `exclamation-triangle`, tone: `text-warning` } as const)
        : ({ name: `info-circle`, tone: `text-subtle` } as const),
);
// The usage column's outline while the accounts are read: the lanes each of two providers' accounts usually carries
// (a week and its session; one monthly pool).
const OUTLINE_LANES = [[`week`, `session`], [`month`]] as const;
</script>

<template>
    <!-- No surface of its own: whitespace and the heading mark it as a region, not a panel with a border or fill. -->
    <!-- Placed and sized by ChatSideRail, which owns the strip this shares with the chat's checklist. -->
    <section class="flex min-h-0 flex-col" :aria-label="t(`chat.chatCapacityRail.planHeadroom`)">
        <!-- One press target, the whole row: a figure alone is too small to aim at, and every one opens the same column. The
             header is the open column's own line, so folding changes what follows the heading, not the heading; the press
             lies over it (a header is no button's content). -->
        <div v-if="folded" class="relative" data-capacity-glance>
            <SectionHeader :label="t(`chat.chatCapacityRail.allowanceLeft`)" density="dense" class="px-3 py-2" aria-hidden="true">
                <template #actions>
                    <span v-if="!accountsLoaded" class="skeleton block h-2.5 w-20" />
                    <span v-for="item in glance" :key="item.provider" class="flex items-center gap-1">
                        <ProviderLogo :provider="item.provider" class="shrink-0 text-2xs" :class="item.spent ? `text-subtle` : `text-muted`" />
                        <span class="text-2xs font-medium tabular-nums" :class="usageTone(item.percent)" :style="meterTint(item.percent)">{{
                            remainingFigure(item.percent, item.stale)
                        }}</span>
                    </span>
                    <Icon v-if="staleNote !== undefined" name="exclamation-circle" class="text-[0.6rem] text-warning" />
                    <Icon name="chevron-up" class="shrink-0 text-[0.6rem] text-subtle" />
                </template>
            </SectionHeader>
            <button
                v-tooltip.left="t(`chat.chatCapacityRail.showAll`)"
                type="button"
                class="absolute inset-0 rounded-[inherit] transition-colors hover:bg-content/4 motion-reduce:transition-none"
                :aria-label="glanceLabel"
                aria-expanded="false"
                @click="opened = true"
            />
        </div>
        <template v-else>
            <!-- The refresh control stays at the edge; the heading beside it names what the figures are. -->
            <!-- Says once what every figure below is, in the row the refresh control already takes, so it costs no height:
             the lanes then carry bare figures, and a word repeated on every lane was width taken from the bars. -->
            <SectionHeader
                :label="measuredProviders.length > 0 ? t(`chat.chatCapacityRail.allowanceLeft`) : undefined"
                density="dense"
                class="shrink-0 px-3 py-2"
            >
                <!-- What has no bar (asideTip): one mark by the heading, every line on its hover card. Focusable, so the
                     keyboard opens the same card. -->
                <template v-if="!asideInline && hasAside" #info>
                    <span
                        v-tooltip.right="asideTip"
                        tabindex="0"
                        class="-ml-1 flex shrink-0 items-center rounded-sm text-[0.65rem] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        :class="asideIcon.tone"
                        data-capacity-aside
                    >
                        <Icon :name="asideIcon.name" aria-hidden="true" />
                        <span class="sr-only">{{ asideSpoken }}</span>
                    </span>
                </template>
                <template #actions>
                    <!-- Readings the age leaves out: a quiet mark by the number it qualifies, the reasons on hover. -->
                    <span v-if="staleNote !== undefined" v-tooltip.left="staleTip" class="flex shrink-0 items-center gap-0.5 text-2xs text-warning">
                        <Icon name="exclamation-circle" class="text-[0.6rem]" />
                        <span class="tabular-nums" aria-hidden="true">{{ staleNote.count }}</span>
                        <span class="sr-only">{{ staleNote.detail }}</span>
                    </span>
                    <button
                        type="button"
                        :class="ui.textButton({ tone: `subtle`, size: `xs` })"
                        :disabled="measuring"
                        :aria-label="remeasureLabel"
                        @click="remeasure"
                    >
                        <Icon name="refresh" class="text-[0.6rem]" :spin="measuring" />
                        <span v-if="capacity.measuredAt !== undefined">{{ formatAge(capacity.measuredAt) }}</span>
                    </button>
                    <!-- Back to the one row, while what it stands under still needs the height. -->
                    <button
                        v-if="fold"
                        v-tooltip.left="t(`chat.chatCapacityRail.showLess`)"
                        type="button"
                        :class="ui.textButton({ tone: `subtle`, size: `xs` })"
                        :aria-label="t(`chat.chatCapacityRail.showLess`)"
                        aria-expanded="true"
                        @click="opened = false"
                    >
                        <Icon name="chevron-down" class="text-[0.6rem]" />
                    </button>
                </template>
            </SectionHeader>

            <!-- Drawn as the shape that's coming while the accounts are read, not stated in words: two providers, each its
                 name over the lanes of one account (a label, a bar, the figure and its reset), in the column's own grid. -->
            <Await :of="reading" imprint="chat.capacity" :label="t(`sandbox.words.readingConnections`)">
                <template #fallback>
                    <div
                        class="flex min-h-0 flex-1 flex-col gap-4 px-3 pb-3"
                        role="status"
                        aria-busy="true"
                        :aria-label="t(`sandbox.words.readingConnections`)"
                    >
                        <div v-for="(lanes, index) in OUTLINE_LANES" :key="index" class="flex flex-col gap-2.5" aria-hidden="true">
                            <div class="flex items-center gap-1.5 text-2xs">
                                <span class="skeleton block size-3 shrink-0" />
                                <span class="flex h-[1lh] items-center"><span class="skeleton block h-2.5 w-20" /></span>
                            </div>
                            <div class="grid grid-cols-[auto_minmax(2.5rem,1fr)_minmax(0,auto)] items-center gap-x-2 gap-y-1">
                                <template v-for="lane in lanes" :key="lane">
                                    <span class="flex h-[1lh] items-center text-3xs"><span class="skeleton block h-2 w-5" /></span>
                                    <span class="skeleton block h-1 rounded-full" />
                                    <span class="flex h-[1lh] items-center justify-end text-2xs"><span class="skeleton block h-2.5 w-16" /></span>
                                </template>
                            </div>
                        </div>
                    </div>
                </template>
                <!-- Gap widens with nesting depth (lane < account < provider); it must grow with lane count or multi-bar accounts read as one long ladder. -->
                <div ref="column" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
                    <!-- Every provider spent at once is an ordinary end-of-week state, not an error, so it's stated plainly. -->
                    <p v-if="capacity.providers.length === 0" class="text-2xs text-muted">{{ t(`chat.chatCapacityRail.nothingRoomRightNow`) }}</p>

                    <!-- One block per provider: the provider is the reader's actual choice here (accounts within it balance automatically). -->
                    <div class="flex flex-col gap-4">
                        <div v-for="entry in measuredProviders" :key="entry.provider" class="flex flex-col gap-2.5">
                            <div class="flex items-center gap-1.5" data-reveal>
                                <ProviderLogo :provider="entry.provider" class="shrink-0 text-2xs text-muted" />
                                <span class="min-w-0 truncate text-2xs font-medium text-content">{{ entry.label }}</span>
                                <span
                                    v-if="entry.hidden > 0"
                                    v-tooltip.left="moreTip(entry.hidden)"
                                    class="flex shrink-0 items-center gap-0.5 text-3xs text-subtle tabular-nums"
                                    aria-hidden="true"
                                    data-more-room
                                >
                                    <Icon name="users" class="text-[0.6rem]" />+{{ entry.hidden }}
                                </span>
                                <span v-if="entry.hidden > 0" class="sr-only">{{ t(`chat.chatCapacityRail.moreRoom`, { hidden: entry.hidden }) }}</span>
                                <span class="flex-1" />
                                <span v-if="headingMine(entry)" class="shrink-0 text-3xs text-subtle">{{ t(`chat.chatCapacityRail.thisChat`) }}</span>
                                <!-- How many accounts have room is the screen reader's: drawn, "24/32" beside every name was a column of
                                 fractions the bars already answer (a spent account has no bar). -->
                                <span v-if="entry.total > 1" class="sr-only">{{ countDetail(entry) }}</span>
                            </div>

                            <!-- One lane per allowance (the 5-hour session and the week run out separately; one tightest-of-two bar couldn't say which). -->
                            <!-- Drawn row is decoration, the sentence below is the content (same split as UsageMeter): a bar means nothing to a screen reader. -->
                            <div class="flex flex-col gap-2.5">
                                <!-- The chat's own account sits on a faint neutral wash that holds its bars together as one block, bleeding
                                 into the gutter so they stay in line with the rows around it; the words say what the wash means. Not the
                                 picker's selected style: its gold edge reads as a press, and nothing in this column is pressed. -->
                                <div
                                    v-for="row in entry.rows"
                                    :key="row.id"
                                    class="flex flex-col gap-1"
                                    :class="{ '-mx-1.5 -my-1 rounded-md bg-content/4 px-1.5 py-1': row.mine }"
                                    :data-mine="row.mine || undefined"
                                    data-reveal
                                >
                                    <!-- The bar keeps a floor and the figure column gives first: a long reset ("za 4 godz. 59 min") once took every
                                     pixel but the bars' own, leaving slivers no one could read. -->
                                    <div
                                        class="grid grid-cols-[auto_minmax(2.5rem,1fr)_minmax(0,auto)] items-center gap-x-2 gap-y-1"
                                        aria-hidden="true"
                                    >
                                        <span
                                            v-if="row.label !== undefined || row.mine"
                                            class="col-span-3 flex min-w-0 items-baseline gap-2 text-2xs"
                                        >
                                            <span class="min-w-0 flex-1 truncate" :class="row.mine ? `text-content` : `text-muted`">{{
                                                row.label
                                            }}</span>
                                            <span v-if="row.mine" class="shrink-0 text-3xs text-subtle">{{
                                                t(`chat.chatCapacityRail.thisChat`)
                                            }}</span>
                                        </span>

                                        <ChatCapacityLane v-for="lane in row.lanes" :key="lane.kind" :lane="lane" :row="row" />

                                        <span v-if="row.lanes.length === 0" class="col-span-3 text-2xs text-subtle">
                                            {{ row.note }}
                                        </span>
                                    </div>
                                    <span class="sr-only">{{ rowDetail(row, entry) }}</span>
                                </div>
                            </div>

                        </div>
                    </div>

                    <!-- One line each, grouped: providers with nothing to measure, then what cannot run. -->
                    <!-- Drawn only while no bars stand above them; otherwise they ride the heading's mark (asideTip). -->
                    <div v-if="asideInline && hasAside" class="flex flex-col gap-1.5">
                        <!-- One line stands for every account of a provider with nothing to measure, so its count is how many it
                         has with room, as a quiet badge on that line: until 2026-11-25 a second line said "+N more with room"
                         under it, N leaving out the rows a capped list would have drawn and this line never does. -->
                        <div v-for="entry in unmeasuredProviders" :key="entry.provider" data-reveal>
                            <div class="flex items-center gap-1.5">
                                <ProviderLogo :provider="entry.provider" class="shrink-0 text-2xs text-muted" aria-hidden="true" />
                                <span class="min-w-0 truncate text-2xs font-medium text-content" aria-hidden="true">{{ entry.label }}</span>
                                <span
                                    v-if="entry.ready > 1"
                                    v-tooltip.left="roomTip(entry.ready)"
                                    class="flex shrink-0 items-center gap-0.5 text-3xs text-subtle tabular-nums"
                                    aria-hidden="true"
                                    data-more-room
                                >
                                    <Icon name="users" class="text-[0.6rem]" />{{ entry.ready }}
                                </span>
                                <span class="flex-1" />
                                <span v-if="entry.mine" class="shrink-0 text-3xs text-subtle" aria-hidden="true">{{ t(`chat.chatCapacityRail.thisChat`) }}</span>
                                <span class="shrink-0 text-2xs text-subtle" aria-hidden="true">{{ entry.rows[0]?.note }}</span>
                            </div>
                            <span class="sr-only">{{ entry.rows[0] ? rowDetail(entry.rows[0], entry) : entry.label }}</span>
                            <span v-if="entry.ready > 1" class="sr-only">{{ plural(entry.ready) }} {{ t(`chat.chatCapacityRail.withRoom`) }}</span>
                        </div>

                        <!-- WHAT CANNOT RUN IS SAID BY TONE, NOT A HEADING: the name dimmed, what holds it in the danger ink (spent) or the
                         warning ink (a fix someone must make), on the same one line as the rows above. Until 2026-11-23 a rule and an
                         "Unavailable" heading took two rows of the column for it; the word is still the screen reader's. -->
                        <span v-if="capacity.out.length > 0 || capacity.blocked.length > 0" class="sr-only">{{
                            t(`chat.chatCapacityRail.unavailable`)
                        }}</span>
                        <div v-for="entry in capacity.out" :key="`out:${entry.provider}`" class="flex items-center gap-1.5" data-reveal>
                            <ProviderLogo :provider="entry.provider" class="shrink-0 text-2xs text-subtle" />
                            <span class="min-w-0 flex-1 truncate text-2xs" :class="entry.mine ? `text-muted` : `text-subtle`">{{ entry.label }}</span>
                            <span v-if="entry.mine" class="shrink-0 text-3xs text-subtle">{{ t(`chat.chatCapacityRail.thisChat`) }}</span>
                            <span class="shrink-0 text-2xs text-danger">{{ outNote(entry) }}</span>
                        </div>
                        <!-- Counted, not listed, one line per condition. Which accounts, the provider's own words and the fix ride the
                         hover: this rail says what can't run, the Agent tab is where it's fixed. -->
                        <div v-for="entry in capacity.blocked" :key="`fix:${entry.fix}`" v-tooltip.left="blockedTip(entry)" data-reveal>
                            <div class="flex items-center gap-1.5" aria-hidden="true">
                                <Icon name="exclamation-triangle" class="shrink-0 text-2xs text-warning" />
                                <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{
                                    t(`chat.chatCapacityRail.cantServe`, { count: entry.count })
                                }}</span>
                                <span class="shrink-0 text-2xs text-warning">{{ entry.reason }}</span>
                            </div>
                            <span class="sr-only"
                                >{{ t(`chat.chatCapacityRail.cantServe`, { count: entry.count }) }} · {{ entry.reason }} ·
                                {{ blockedDetail(entry) }}</span
                            >
                        </div>
                    </div>
                </div>
            </Await>
        </template>
    </section>
</template>
