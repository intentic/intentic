<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract";
import { localZone, zoneLabel } from "@intentic/sandbox-contract/time";
import { activeLocale, Button, formatClock, formatDateTime, Icon, type IconName, ResponsiveOverlay, ui, useNarrow, useNow } from "@intentic/extension-ui";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { addDays, calendarWeek, type CalendarEntry, type EntryState, instantAt, type LaneBar, layoutDay, minuteOfDay, weekStartOf } from "./calendarModel";
import CalendarPeek from "./CalendarPeek.vue";
import { scheduleTriggerLabel } from "./cronSchedule";
import RunStrip from "./RunStrip.vue";
import { useSandboxZone } from "./useAutomations";
import { t } from "./i18n.js";

// The time lens over the same automations the list shows: one week, Monday first, on the reader's own clock. A slot is a
// wake that happened (from the run ledger) or one that will (from the rule); a rule firing many times a day is a bar
// in the lane over the grid instead of a wall of slots. Clicking a slot opens what it is; clicking free time starts a
// one-time wake there. On a narrow pane the same week reads as an agenda, since seven columns of a phone's width hold
// nothing legible.

const props = defineProps<{
    automations: readonly AutomationSummary[];
    busy?: boolean;
    /** A one-time wake being composed at this moment, drawn where it will sit until it is saved or dropped. */
    draft?: number;
}>();
const emit = defineEmits<{ create: [at: number]; edit: [id: string]; run: [id: string]; toggle: [id: string, enabled: boolean]; list: [] }>();

// One hour's height, and a slot's: a wake has no duration, so the slot is drawn a fixed half hour tall and two wakes
// closer than that sit side by side.
const HOUR_PX = 44;
const SLOT_PX = 22;
const SLOT_MINUTES = (SLOT_PX / HOUR_PX) * 60;
// Free time snaps to quarter hours, the grain anyone sets a reminder at.
const SNAP_MINUTES = 15;
const DAY_MINUTES = 24 * 60;

const sandboxZone = useSandboxZone();
// Each minute is enough: it moves the now line and the split between ledger and rule, neither of which reads seconds.
const now = useNow(true, 60_000);
const weekStart = ref(weekStartOf(Date.now()));
const showPaused = ref(false);

const week = computed(() => calendarWeek(props.automations, weekStart.value, now.value, sandboxZone.value));
const isCurrentWeek = computed(() => weekStart.value === weekStartOf(now.value));

/* ---- the popover ---- */

type Peeked = { readonly kind: `entry`; readonly key: string } | { readonly kind: `bar`; readonly key: string };
const peeked = ref<Peeked>();
const anchor = ref<HTMLElement>();
const peekOpen = computed({
    get: () => peeked.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            peeked.value = undefined;
        }
    },
});
// Read back from the live week, so a toggle or a run landing under an open popover shows in it.
const peekEntry = computed<CalendarEntry | undefined>(() =>
    peeked.value?.kind === `entry` ? week.value.entries.find((entry) => entry.key === peeked.value?.key) : undefined,
);
const peekBar = computed<LaneBar | undefined>(() => (peeked.value?.kind === `bar` ? week.value.lane.find((bar) => bar.key === peeked.value?.key) : undefined));
const peekAutomation = computed(() => {
    const id = peekEntry.value?.automation.id ?? peekBar.value?.automation.id;
    return props.automations.find((automation) => automation.id === id);
});

const open = (event: Event, target: Peeked): void => {
    anchor.value = event.currentTarget as HTMLElement;
    peeked.value = target;
};
const close = (): void => {
    peeked.value = undefined;
};

/* ---- what is drawn ---- */

// A switched-off automation is left out unless asked for, but never the one the popover is open on: switching it off
// from there must not pull the slot it hangs from out from under it.
const showing = (paused: boolean, automation: AutomationSummary): boolean => !paused || showPaused.value || automation.id === peekAutomation.value?.id;
const entries = computed(() => week.value.entries.filter((entry) => showing(entry.state === `paused`, entry.automation)));
const lane = computed(() => week.value.lane.filter((bar) => showing(bar.paused, bar.automation)));
const pausedCount = computed(
    () =>
        new Set([
            ...week.value.entries.filter((entry) => entry.state === `paused`).map((entry) => entry.automation.id),
            ...week.value.lane.filter((bar) => bar.paused).map((bar) => bar.automation.id),
        ]).size,
);

const isToday = (day: number): boolean => day <= now.value && now.value < addDays(day, 1);
const columns = computed(() =>
    week.value.days.map((day, index) => ({
        day,
        index,
        date: new Date(day).getDate(),
        today: isToday(day),
        placed: layoutDay(
            entries.value.filter((entry) => entry.day === index),
            SLOT_MINUTES,
        ),
    })),
);

// One automation lit across the week while the pointer is on any of its slots: the others step back.
const hovered = ref<string>();
const dimmed = (id: string): boolean => hovered.value !== undefined && hovered.value !== id;

// Ahead is the accent, because ahead is what a calendar is for; behind is ink, and only a failure takes a hue of its
// own, as on the list. Switched off is an outline with nothing inside it: where it would be, not that it will be.
const SLOT_TONE: Record<EntryState, string> = {
    upcoming: `bg-link/10 text-link hover:bg-link/20`,
    paused: `border border-dashed border-line-strong text-subtle hover:text-muted`,
    completed: `bg-content/5 text-muted hover:bg-content/10`,
    error: `bg-danger/15 text-danger hover:bg-danger/20`,
    skipped: `border border-line-subtle text-subtle hover:bg-content/5`,
    interrupted: `border border-line-subtle text-subtle hover:bg-content/5`,
};
const slotIcon = (entry: CalendarEntry): IconName => {
    if (entry.state === `upcoming`) {
        return entry.automation.trigger.kind === `once` ? `pin` : `clock`;
    }
    return ({ paused: `pause`, completed: `check`, error: `exclamation-circle`, skipped: `minus`, interrupted: `minus` } as const)[entry.state];
};
const stateWord = (state: EntryState): string => t(`calendar.state.${state}`);
const spoken = (entry: CalendarEntry): string => `${entry.automation.id}, ${stateWord(entry.state)} ${formatDateTime(entry.at)}`;

const slotStyle = (placed: { item: CalendarEntry; column: number; columns: number }): Record<string, string> => ({
    top: `${(Math.min(placed.item.minute, DAY_MINUTES - SLOT_MINUTES) / 60) * HOUR_PX}px`,
    height: `${SLOT_PX}px`,
    left: `calc(${(placed.column / placed.columns) * 100}% + 2px)`,
    width: `calc(${100 / placed.columns}% - 4px)`,
});

const cadence = (bar: LaneBar): string =>
    bar.automation.trigger.kind === `schedule` ? scheduleTriggerLabel(bar.automation.trigger, localZone(), sandboxZone.value) : ``;

/* ---- words ---- */

// allow(format-tiers): rebuilt from activeLocale when the language changes; the kit has no weekday or date-range formatter.
const weekdayFormat = computed(() => new Intl.DateTimeFormat(activeLocale.value, { weekday: `short` }));
// allow(format-tiers): rebuilt from activeLocale when the language changes; the kit has no weekday or date-range formatter.
const dayFormat = computed(() => new Intl.DateTimeFormat(activeLocale.value, { weekday: `long`, day: `numeric`, month: `long` }));
const rangeLabel = computed(() =>
    // allow(format-tiers): rebuilt from activeLocale when the language changes; the kit has no weekday or date-range formatter.
    new Intl.DateTimeFormat(activeLocale.value, { day: `numeric`, month: `short`, year: `numeric` }).formatRange(weekStart.value, addDays(weekStart.value, 6)),
);
const hourLabel = (hour: number): string => formatClock(instantAt(weekStart.value, hour * 60));
// The grid is the reader's clock; said only when the sandbox keeps another, which is when a "03:00" could be misread.
const zoneNote = computed<string | undefined>(() =>
    zoneLabel(sandboxZone.value, localZone()) === undefined ? undefined : t(`calendar.yourClock`, { zone: localZone().replace(/_/g, ` `) }),
);

/* ---- moving through weeks ---- */

const shift = (by: number): void => {
    weekStart.value = addDays(weekStart.value, by * 7);
};
const goToday = (): void => {
    weekStart.value = weekStartOf(Date.now());
};

/* ---- free time ---- */

const ghost = ref<{ day: number; minute: number }>();
const slotAt = (event: MouseEvent, day: number): { minute: number; at: number } | undefined => {
    // Only the column's own ground: a slot, the now line and the ghost are its children, and none of them is free time.
    if (event.target !== event.currentTarget) {
        return undefined;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const raw = ((event.clientY - rect.top) / HOUR_PX) * 60;
    const minute = Math.min(DAY_MINUTES - SNAP_MINUTES, Math.max(0, Math.floor(raw / SNAP_MINUTES) * SNAP_MINUTES));
    const at = instantAt(week.value.days[day] ?? weekStart.value, minute);
    // A one-time wake set in the past would fire on the spot, which nobody clicking yesterday meant.
    return at > now.value ? { minute, at } : undefined;
};
const hover = (event: PointerEvent, day: number): void => {
    const slot = event.pointerType === `mouse` ? slotAt(event, day) : undefined;
    ghost.value = slot === undefined ? undefined : { day, minute: slot.minute };
};
const pick = (event: MouseEvent, day: number): void => {
    const slot = slotAt(event, day);
    if (slot !== undefined) {
        ghost.value = undefined;
        emit(`create`, slot.at);
    }
};

/* ---- where the scroll opens ---- */

// The pinned heads sit over the scroll's own top, so scrolling to an hour's offset in the body lands it just under them.
const scroller = ref<HTMLElement>();
// An hour above the earliest thing worth seeing this week, now included: a page of empty small hours above a 09:00
// chore is the first thing a calendar opened at midnight would show.
const scrollToWork = (): void => {
    const minutes = [...entries.value.map((entry) => entry.minute), ...(isCurrentWeek.value ? [minuteOfDay(now.value)] : [])];
    const first = minutes.length === 0 ? 8 * 60 : Math.min(...minutes);
    // Half a label's height short of the hour, so its own gutter label is not cut by the pinned heads.
    scroller.value?.scrollTo({ top: Math.max(0, ((first - 60) / 60) * HOUR_PX - 8) });
};
onMounted(scrollToWork);
watch(weekStart, () => void nextTick(scrollToWork));

/* ---- a narrow pane ---- */

const root = ref<HTMLElement>();
const narrow = useNarrow(root, 40);
// Below this the columns are too narrow for a slot to carry its time beside its name.
const cramped = useNarrow(root, 64);
// The grid mounts afresh when a pane widens out of the agenda, and opens on the morning's work like it did the first time.
watch(narrow, (isNarrow) => {
    if (!isNarrow) {
        void nextTick(scrollToWork);
    }
});
const agenda = computed(() =>
    columns.value
        .map((column) => ({ ...column, items: entries.value.filter((entry) => entry.day === column.index) }))
        .filter((column) => column.items.length > 0),
);
// Where today's list crosses now, so the agenda draws the line the grid does.
const firstAhead = computed(() => entries.value.find((entry) => entry.at >= now.value)?.key);

const nowTop = computed(() => (minuteOfDay(now.value) / 60) * HOUR_PX);
const draftSlot = computed(() => {
    const at = props.draft;
    const day = at === undefined ? -1 : week.value.days.findLastIndex((start) => start <= at);
    return at === undefined || day < 0 || at >= addDays(weekStart.value, 7) ? undefined : { day, top: (minuteOfDay(at) / 60) * HOUR_PX, at };
});
const empty = computed(() => entries.value.length === 0 && lane.value.length === 0);
const GRID = { gridTemplateColumns: `3.5rem repeat(7, minmax(0, 1fr))` };
const HOUR_LINES = {
    height: `${24 * HOUR_PX}px`,
    backgroundImage: `repeating-linear-gradient(to bottom, var(--color-line-subtle) 0 1px, transparent 1px ${HOUR_PX}px)`,
};
</script>

<template>
    <div ref="root" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div class="flex items-center gap-1">
                <Button :label="t(`calendar.today`)" size="small" severity="secondary" :disabled="isCurrentWeek" @click="goToday" />
                <button type="button" :class="ui.iconButton()" :aria-label="t(`calendar.previousWeek`)" v-tooltip.top="t(`calendar.previousWeek`)" @click="shift(-1)">
                    <Icon name="chevron-left" class="text-xs" />
                </button>
                <button type="button" :class="ui.iconButton()" :aria-label="t(`calendar.nextWeek`)" v-tooltip.top="t(`calendar.nextWeek`)" @click="shift(1)">
                    <Icon name="chevron-right" class="text-xs" />
                </button>
            </div>
            <h2 class="text-sm font-semibold text-content tabular-nums" aria-live="polite">{{ rangeLabel }}</h2>
            <div class="ml-auto flex items-center gap-3">
                <span v-if="zoneNote" class="text-2xs text-subtle">{{ zoneNote }}</span>
                <button
                    v-if="pausedCount > 0"
                    type="button"
                    class="ui-chip"
                    :class="showPaused ? `ui-chip-on` : ``"
                    :aria-pressed="showPaused"
                    @click="showPaused = !showPaused"
                >
                    <Icon name="pause" />
                    {{ t(`calendar.paused`, { count: pausedCount }, pausedCount) }}
                </button>
            </div>
        </div>

        <!-- The agenda: the same week as a list of days, for a pane too narrow for seven columns. -->
        <div v-if="narrow" class="flex flex-col gap-4">
            <div v-if="lane.length > 0" class="flex flex-col gap-1">
                <span :class="ui.sectionLabel(`px-1 text-2xs`)">{{ t(`calendar.throughTheDay`) }}</span>
                <button
                    v-for="bar in lane"
                    :key="bar.key"
                    type="button"
                    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
                    :class="bar.paused ? SLOT_TONE.paused : SLOT_TONE.upcoming"
                    @click="open($event, { kind: `bar`, key: bar.key })"
                >
                    <Icon name="repeat" class="shrink-0 text-2xs" />
                    <span class="min-w-0 truncate font-medium">{{ bar.automation.id }}</span>
                    <span class="min-w-0 truncate opacity-75">{{ cadence(bar) }}</span>
                    <span class="ml-auto w-14 shrink-0"><RunStrip :runs="bar.automation.runs" /></span>
                </button>
            </div>
            <section v-for="day in agenda" :key="day.day" class="flex flex-col gap-1">
                <h3 class="px-1 text-2xs font-semibold" :class="day.today ? `text-link` : `text-subtle`">
                    {{ day.today ? `${t(`calendar.today`)} · ` : `` }}{{ dayFormat.format(day.day) }}
                </h3>
                <template v-for="entry in day.items" :key="entry.key">
                    <div v-if="isCurrentWeek && entry.key === firstAhead" class="flex items-center gap-2 px-1" aria-hidden="true">
                        <span class="size-1.5 rounded-full bg-primary-500"></span>
                        <span class="h-px flex-1 bg-primary-500/50"></span>
                    </div>
                    <button
                        type="button"
                        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
                        :class="SLOT_TONE[entry.state]"
                        :aria-label="spoken(entry)"
                        @click="open($event, { kind: `entry`, key: entry.key })"
                    >
                        <span class="w-11 shrink-0 tabular-nums opacity-80">{{ formatClock(entry.at) }}</span>
                        <Icon :name="slotIcon(entry)" class="shrink-0 text-2xs" />
                        <span class="min-w-0 truncate font-medium">{{ entry.automation.id }}</span>
                        <span class="ml-auto shrink-0 text-2xs opacity-75">{{ stateWord(entry.state) }}</span>
                    </button>
                </template>
            </section>
            <p v-if="empty" :class="ui.emptyState(`py-6`)">{{ t(`calendar.nothingThisWeek`) }}</p>
        </div>

        <!-- The week grid. The day heads and the lane scroll with it, pinned, so all three share one width and the columns
             line up whatever the scrollbar takes. -->
        <div v-else class="relative overflow-hidden rounded-lg bg-card shadow-sm">
            <div ref="scroller" class="overflow-y-auto" :style="{ height: `clamp(24rem, calc(100dvh - 14rem), 48rem)` }">
                <div class="sticky top-0 z-10 bg-card">
                    <div class="grid border-b border-line-subtle" :style="GRID">
                        <div></div>
                        <div v-for="column in columns" :key="column.day" class="flex flex-col items-center gap-0.5 border-l border-line-subtle py-2">
                            <span class="text-3xs font-semibold tracking-wide uppercase" :class="column.today ? `text-link` : `text-subtle`">
                                {{ weekdayFormat.format(column.day) }}
                            </span>
                            <span
                                class="flex size-7 items-center justify-center rounded-full text-sm tabular-nums"
                                :class="column.today ? `bg-primary-500 font-semibold text-white` : `text-content`"
                            >
                                {{ column.date }}
                            </span>
                        </div>
                    </div>

                    <!-- The lane: a rule firing through the day, one bar over the days it fires on. -->
                    <div v-if="lane.length > 0" class="grid gap-y-1 border-b border-line-subtle py-1.5" :style="GRID">
                        <div class="flex items-center justify-end pr-2" :style="{ gridRow: `1 / span ${lane.length}` }">
                            <Icon name="repeat" class="text-2xs text-subtle" v-tooltip.top="t(`calendar.allDay`)" />
                        </div>
                        <button
                            v-for="(bar, row) in lane"
                            :key="bar.key"
                            type="button"
                            class="mx-0.5 flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-2xs transition"
                            :class="[bar.paused ? SLOT_TONE.paused : SLOT_TONE.upcoming, dimmed(bar.automation.id) ? `opacity-40` : ``]"
                            :style="{ gridColumn: `${bar.from + 2} / ${bar.to + 3}`, gridRow: `${row + 1}` }"
                            :aria-label="`${bar.automation.id}, ${cadence(bar)}`"
                            @click="open($event, { kind: `bar`, key: bar.key })"
                            @pointerenter="hovered = bar.automation.id"
                            @pointerleave="hovered = undefined"
                        >
                            <Icon :name="bar.paused ? `pause` : `repeat`" class="shrink-0" />
                            <span class="min-w-0 truncate font-medium">{{ bar.automation.id }}</span>
                            <span class="min-w-0 truncate opacity-75">{{ cadence(bar) }}</span>
                            <span v-if="bar.to - bar.from >= 2" class="ml-auto w-14 shrink-0"><RunStrip :runs="bar.automation.runs" /></span>
                        </button>
                    </div>
                </div>

                <div class="grid" :style="[GRID, { height: HOUR_LINES.height }]">
                    <div class="relative" aria-hidden="true">
                        <span
                            v-for="hour in 23"
                            :key="hour"
                            class="absolute right-2 -translate-y-1/2 text-3xs text-subtle tabular-nums"
                            :style="{ top: `${hour * HOUR_PX}px` }"
                        >
                            {{ hourLabel(hour) }}
                        </span>
                    </div>
                    <div
                        v-for="column in columns"
                        :key="column.day"
                        class="relative border-l border-line-subtle"
                        :class="[column.today ? `bg-link/2` : ``, ghost?.day === column.index ? `cursor-pointer` : ``]"
                        :style="HOUR_LINES"
                        @pointermove="hover($event, column.index)"
                        @pointerleave="ghost = undefined"
                        @click="pick($event, column.index)"
                    >
                        <button
                            v-for="placed in column.placed"
                            :key="placed.item.key"
                            type="button"
                            class="absolute z-1 flex cursor-pointer items-center gap-1 overflow-hidden rounded-md px-1.5 text-left text-2xs leading-none transition"
                            :class="[
                                SLOT_TONE[placed.item.state],
                                dimmed(placed.item.automation.id) ? `opacity-40` : ``,
                                peeked?.key === placed.item.key ? `ring-2 ring-primary-500` : ``,
                            ]"
                            :style="slotStyle(placed)"
                            :aria-label="spoken(placed.item)"
                            v-tooltip.top="spoken(placed.item)"
                            @click.stop="open($event, { kind: `entry`, key: placed.item.key })"
                            @pointerenter="hovered = placed.item.automation.id"
                            @pointerleave="hovered = undefined"
                        >
                            <Icon :name="slotIcon(placed.item)" class="shrink-0 text-3xs" />
                            <span class="min-w-0 truncate font-medium">{{ placed.item.automation.id }}</span>
                            <span v-if="!cramped && placed.columns === 1" class="shrink-0 tabular-nums opacity-75">{{ formatClock(placed.item.at) }}</span>
                        </button>

                        <!-- The moment the composer above is setting, held in place until it is saved or dropped. -->
                        <div
                            v-if="draftSlot?.day === column.index"
                            class="pointer-events-none absolute inset-x-0.5 z-2 flex items-center gap-1 rounded-md border border-dashed border-primary-500 bg-primary-500/15 px-1.5 text-2xs font-medium text-link"
                            :style="{ top: `${draftSlot.top}px`, height: `${SLOT_PX}px` }"
                            aria-hidden="true"
                        >
                            <Icon name="pin" class="text-3xs" />
                            <span class="tabular-nums">{{ formatClock(draftSlot.at) }}</span>
                        </div>

                        <!-- Free time under the pointer, as the one-time wake a click would set there. -->
                        <div
                            v-if="ghost?.day === column.index"
                            class="pointer-events-none absolute inset-x-0.5 z-2 flex items-center gap-1 rounded-md border border-dashed border-primary-500/50 bg-primary-500/10 px-1.5 text-2xs text-link"
                            :style="{ top: `${(ghost.minute / 60) * HOUR_PX}px`, height: `${SLOT_PX}px` }"
                            aria-hidden="true"
                        >
                            <Icon name="plus" class="text-3xs" />
                            <span class="tabular-nums">{{ formatClock(instantAt(column.day, ghost.minute)) }}</span>
                        </div>

                        <div v-if="column.today" class="pointer-events-none absolute inset-x-0 z-3 h-0.5 bg-primary-500" :style="{ top: `${nowTop}px` }" aria-hidden="true">
                            <span class="absolute -left-1 size-2 rounded-full bg-primary-500" :style="{ top: `-3px` }"></span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Said over the grid rather than instead of it: the grid is still where a click sets one. -->
            <div v-if="empty" class="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                <div class="flex max-w-xs flex-col items-center gap-1 rounded-lg bg-canvas/90 px-4 py-3 text-center shadow-sm backdrop-blur-sm">
                    <span class="text-sm text-content">{{ t(`calendar.nothingThisWeek`) }}</span>
                    <span class="text-2xs text-subtle">{{ t(`calendar.clickToSet`) }}</span>
                </div>
            </div>
        </div>

        <!-- What the calendar cannot place, named so a reader doesn't take the grid for everything there is. -->
        <p v-if="week.elsewhere.length > 0" class="flex flex-wrap items-center gap-1.5 px-1 text-2xs text-subtle">
            <Icon name="bolt" class="text-3xs" />
            <span v-tooltip.top="week.elsewhere.map((automation) => automation.id).join(`, `)">
                {{ t(`calendar.elsewhere`, { count: week.elsewhere.length }, week.elsewhere.length) }}
            </span>
            <button type="button" class="cursor-pointer text-link hover:underline" @click="emit(`list`)">{{ t(`calendar.openList`) }}</button>
        </p>

        <!-- No sheet title on a phone: the card names its automation itself, and a second name above it would only repeat. -->
        <ResponsiveOverlay v-model="peekOpen" :anchor="anchor" panel-class="w-80 p-3" side="right" cross="start">
            <CalendarPeek
                v-if="peekAutomation"
                :automation="peekAutomation"
                :at="peekEntry?.at"
                :state="peekEntry?.state"
                :run="peekEntry?.run"
                :busy="busy"
                @run="emit(`run`, peekAutomation.id)"
                @edit="
                    emit(`edit`, peekAutomation.id);
                    close();
                "
                @toggle="emit(`toggle`, peekAutomation.id, $event)"
            />
        </ResponsiveOverlay>
    </div>
</template>
