<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { formatDayLong, formatMonth, formatMonthShort, formatWeekday, weekStart } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
    bookableDays,
    type CalendarDay,
    calendarWeeks,
    CLOCK_CHIPS,
    clockText,
    dayOf,
    defaultClock,
    draftInstant,
    minuteOfDay,
    moveDay,
    parseClock,
    stepClock,
} from "./laterCalendar";
import { bookable, SOONEST_SEND_MS } from "./sendLater";

/* A time of the reader's own, inside the send-later panel: the thirty days a booking can land on as the weeks they
   fall in, a time of day typed or pressed, and the line that says when that sends. Nothing to press to keep it: the
   pick is kept the moment the reader leaves it (focus moving out, the panel closing, the window losing focus) or
   presses Enter in the time, and dropped only by going Back or pressing Escape. Pure layout and keys; laterCalendar.ts
   has the arithmetic. */

const props = defineProps<{
    now: number;
    // The time already picked, which the picker opens on; a leave that changed nothing keeps it without a word.
    initial?: number | undefined;
}>();
const emit = defineEmits<{ commit: [at: number]; back: [] }>();

const t = useT();

const day = ref(props.initial === undefined ? undefined : dayOf(props.initial));
const clock = ref(props.initial === undefined ? undefined : minuteOfDay(props.initial));
// What the time field holds, as typed: read on every keystroke, tidied to "09:30" once the reader moves on.
const typed = ref(clock.value === undefined ? `` : clockText(clock.value));
// Whether the reader has done anything here: opening the picker and leaving it again books nothing.
const touched = ref(false);

const typedBad = computed(() => typed.value.trim() !== `` && parseClock(typed.value) === undefined);
const instant = computed(() => (typedBad.value ? undefined : draftInstant({ day: day.value, clock: clock.value }, props.now)));
const ok = computed(() => instant.value !== undefined && bookable(instant.value, props.now));
// The time the pick lands at, typed or not: a day picked alone shows its default on the chip that names it.
const shownClock = computed(() => (instant.value === undefined ? undefined : minuteOfDay(instant.value)));
// The day the grid marks: the one picked, or the one a time alone lands on.
const shownDay = computed(() => (instant.value === undefined ? day.value : dayOf(instant.value)));

const firstWeekday = weekStart();
const weeks = computed(() => calendarWeeks(props.now, firstWeekday));
const range = computed(() => bookableDays(props.now));
const heading = computed(() => {
    const from = formatMonth(range.value.first);
    const to = formatMonth(range.value.last);
    return from === to ? from : t(`chat.sendLater.monthRange`, { from, to });
});

// The line under the picker: what leaving now books, or what is missing, or what is wrong.
interface Summary {
    readonly text: string;
    readonly tone: `ok` | `warn` | `idle`;
}
const summary = computed((): Summary => {
    if (typedBad.value) {
        return { text: t(`chat.sendLater.typeTime`), tone: `warn` };
    }
    const at = instant.value;
    if (at === undefined) {
        return { text: t(`chat.sendLater.pickPrompt`), tone: `idle` };
    }
    if (!bookable(at, props.now)) {
        return { text: at < props.now + SOONEST_SEND_MS ? t(`chat.sendLater.passed`) : t(`chat.sendLater.outOfRange`), tone: `warn` };
    }
    return { text: t(`chat.sendLater.sendsWhen`, { when: formatUntil(at, props.now) }), tone: `ok` };
});

// The field's hint is the time a picked day gets when none is typed, so a day alone reads as complete.
const placeholder = computed(() => clockText(defaultClock(day.value ?? range.value.first, props.now)));

/* ---- keeping it, or not ---- */

// Spent once the pick is kept or dropped, so the close that follows a keep does not keep it twice.
let settled = false;
const commit = (): void => {
    const at = instant.value;
    if (settled || !touched.value || at === undefined || !ok.value || at === props.initial) {
        return;
    }
    settled = true;
    emit(`commit`, at);
};
const back = (): void => {
    settled = true;
    emit(`back`);
};
// The panel closing under the picker (a press outside it, the window losing focus, a sheet swiped away) is a leave.
onBeforeUnmount(commit);

const root = ref<HTMLElement>();
// Focus moving to anything outside the picker is a leave. A null target is not: the press outside that sent it there
// closes the panel, and the unmount above keeps the pick.
const onFocusout = (event: FocusEvent): void => {
    // SAFETY: a focusout's relatedTarget is the element focus went to, or null.
    const to = event.relatedTarget as Node | null;
    if (to !== null && root.value?.contains(to) === false) {
        commit();
    }
};

/* ---- the days ---- */

const pickDay = (picked: number): void => {
    day.value = picked;
    focusDay.value = picked;
    touched.value = true;
};

// The one day the grid's Tab stop sits on; the arrow keys move it (a roving tabindex, as a date grid has).
const focusDay = ref(shownDay.value ?? range.value.first);
const grid = ref<HTMLElement>();
const focusOn = async (target: number): Promise<void> => {
    focusDay.value = target;
    await nextTick();
    grid.value?.querySelector<HTMLButtonElement>(`[data-day="${target}"]`)?.focus({ preventScroll: true });
};
const GRID_STEPS = new Map([
    [`ArrowLeft`, -1],
    [`ArrowRight`, 1],
    [`ArrowUp`, -7],
    [`ArrowDown`, 7],
]);
const onGridKey = (event: KeyboardEvent): void => {
    const column = (new Date(focusDay.value).getDay() - firstWeekday + 7) % 7;
    const by = event.key === `Home` ? -column : event.key === `End` ? 6 - column : GRID_STEPS.get(event.key);
    if (by === undefined) {
        return;
    }
    event.preventDefault();
    void focusOn(moveDay(focusDay.value, by, props.now));
};
onMounted(() => void focusOn(focusDay.value));

const dayClass = (cell: CalendarDay): string => {
    if (cell.day === shownDay.value) {
        return `bg-primary-fill font-semibold text-fill-content`;
    }
    if (!cell.bookable) {
        return `cursor-default text-subtle opacity-45`;
    }
    return cell.today ? `font-semibold text-link hover:bg-overlay` : `text-content hover:bg-overlay`;
};

/* ---- the time ---- */

// Typing names the time as soon as it reads as one; a half-typed one keeps the last, and the summary says what is off.
const typedField = computed({
    get: () => typed.value,
    set: (text: string) => {
        typed.value = text;
        touched.value = true;
        clock.value = text.trim() === `` ? undefined : (parseClock(text) ?? clock.value);
    },
});
const pickClock = (minutes: number): void => {
    clock.value = minutes;
    typed.value = clockText(minutes);
    touched.value = true;
};
// Focusing the field selects what it holds, so typing a time replaces the one there rather than running into it. After
// the press that focused it, which would otherwise put the caret back where it landed.
const selectTyped = (event: FocusEvent): void => {
    // SAFETY: bound on the time field's own focus.
    const field = event.target as HTMLInputElement;
    requestAnimationFrame(() => field.select());
};
const tidyTyped = (): void => {
    const parsed = parseClock(typed.value);
    if (parsed !== undefined) {
        typed.value = clockText(parsed);
    }
};
const onClockKey = (event: KeyboardEvent): void => {
    if (event.key === `Enter`) {
        event.preventDefault();
        commit();
        return;
    }
    if (event.key === `ArrowUp` || event.key === `ArrowDown`) {
        event.preventDefault();
        const from = clock.value ?? (instant.value === undefined ? defaultClock(range.value.first, props.now) : minuteOfDay(instant.value));
        pickClock(stepClock(from, event.key === `ArrowUp` ? 1 : -1));
    }
};
</script>

<template>
    <!-- tabindex -1: a press on the picker's own padding keeps focus inside it, rather than dropping it to the page and reading as a leave. -->
    <div ref="root" tabindex="-1" class="flex flex-col focus:outline-none" @focusout="onFocusout" @keydown.esc.stop.prevent="back()">
        <div class="flex items-center gap-1 pb-1">
            <button
                type="button"
                :class="ui.iconButton({ size: `md` })"
                v-tooltip.top="t(`ui.action.back`)"
                :aria-label="t(`ui.action.back`)"
                @click="back()"
            >
                <Icon name="chevron-left" class="text-xs" />
            </button>
            <span class="truncate text-xs font-medium text-content">{{ t(`chat.sendLater.pickTime`) }}</span>
        </div>

        <div class="px-1.5">
            <p class="px-1 pb-1 text-sm font-medium text-content md:text-xs">{{ heading }}</p>
            <div ref="grid" role="grid" :aria-label="heading" @keydown="onGridKey">
                <div role="row" class="grid grid-cols-7">
                    <span v-for="cell in weeks[0]" :key="cell.day" role="columnheader" class="py-1 text-center text-3xs font-medium text-subtle">
                        {{ formatWeekday(cell.day) }}
                    </span>
                </div>
                <div v-for="week in weeks" :key="week[0]?.day" role="row" class="grid grid-cols-7">
                    <span
                        v-for="cell in week"
                        :key="cell.day"
                        role="gridcell"
                        :aria-selected="cell.day === shownDay"
                        class="flex justify-center py-px"
                    >
                        <button
                            type="button"
                            :data-day="cell.day"
                            :tabindex="cell.day === focusDay ? 0 : -1"
                            :disabled="!cell.bookable"
                            :aria-label="formatDayLong(cell.day)"
                            :aria-current="cell.today ? `date` : undefined"
                            class="relative flex size-8 items-center justify-center rounded-full text-xs leading-none tabular-nums transition-colors max-md:size-10 max-md:text-sm"
                            :class="dayClass(cell)"
                            @click="pickDay(cell.day)"
                        >
                            <!-- The grid runs on into the next month: its first day says which. -->
                            <span
                                v-if="cell.monthStart"
                                class="absolute top-0.5 text-[0.5rem] leading-none font-semibold uppercase opacity-75 max-md:top-1"
                                >{{ formatMonthShort(cell.day) }}</span
                            >
                            {{ cell.date }}
                            <span v-if="cell.today" class="absolute bottom-1 size-1 rounded-full bg-current" aria-hidden="true" />
                        </button>
                    </span>
                </div>
            </div>
        </div>

        <div class="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1">
            <span class="relative flex shrink-0 items-center">
                <Icon name="clock" class="pointer-events-none absolute left-2 text-2xs text-subtle" />
                <input
                    v-model="typedField"
                    type="text"
                    inputmode="numeric"
                    autocomplete="off"
                    spellcheck="false"
                    maxlength="8"
                    :placeholder="placeholder"
                    :aria-label="t(`chat.sendLater.time`)"
                    :aria-invalid="typedBad"
                    :class="[ui.input({ size: `sm` }), `w-[4.75rem] pl-6 tabular-nums max-md:w-24`, typedBad ? `ui-field-error-box` : ``]"
                    @focus="selectTyped"
                    @blur="tidyTyped()"
                    @keydown="onClockKey"
                />
            </span>
            <span class="flex min-w-0 flex-1 gap-1">
                <button
                    v-for="minutes in CLOCK_CHIPS"
                    :key="minutes"
                    type="button"
                    :class="ui.chip({ on: shownClock === minutes }, `min-w-0 flex-1 cursor-pointer justify-center px-0 tabular-nums`)"
                    @click="pickClock(minutes)"
                >
                    {{ clockText(minutes) }}
                </button>
            </span>
        </div>

        <!-- What leaving now would book, said the way the pill will say it; or what is missing, or what is wrong. -->
        <p class="mx-1 mt-1.5 flex items-start gap-2 border-t border-line-subtle px-1.5 pt-2 pb-1" aria-live="polite">
            <Icon
                :name="summary.tone === `ok` ? `send` : summary.tone === `warn` ? `exclamation-circle` : `calendar`"
                class="mt-0.5 shrink-0 text-xs"
                :class="summary.tone === `warn` ? `text-warning` : `text-subtle`"
            />
            <span class="flex min-w-0 flex-col">
                <span
                    class="text-sm md:text-xs"
                    :class="summary.tone === `warn` ? `text-warning` : summary.tone === `ok` ? `text-content` : `text-subtle`"
                    >{{ summary.text }}</span
                >
                <span v-if="summary.tone === `ok` && touched" class="text-2xs text-subtle">{{ t(`chat.sendLater.savedOnLeave`) }}</span>
            </span>
        </p>
    </div>
</template>
