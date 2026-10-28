<!-- A day on the reader's own calendar, picked off a month's grid that pages a month at a time: the app's own, never the browser's date popup. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useT } from "../../i18n/index.js";
import { addDays, dayOf, type MonthDay, monthOf, monthWeeks } from "../../lib/clock.js";
import { formatDayLong, formatMonthYear, formatWeekday, weekStart } from "../../lib/format.js";
import { ui } from "../../lib/ui.js";
import Icon from "../primitives/Icon.vue";

const t = useT();

const { min, max, now = Date.now() } = defineProps<{
    /** The first instant that may be picked: every day before the one holding it is drawn but cannot be pressed. */
    min?: number | undefined;
    /** The last instant that may be picked. */
    max?: number | undefined;
    /** What "today" is; the reader's clock unless a caller holds its own. */
    now?: number;
}>();

/** The day picked, as its local midnight; undefined until one is. */
const day = defineModel<number | undefined>();

const firstWeekday = weekStart();
const firstDay = computed(() => (min === undefined ? undefined : dayOf(min)));
const lastDay = computed(() => (max === undefined ? undefined : dayOf(max)));
const pickable = (cell: number): boolean => (firstDay.value === undefined || cell >= firstDay.value) && (lastDay.value === undefined || cell <= lastDay.value);

// The month on show: the picked day's, else the first pickable one's, else this one. Follows a day set from outside.
const month = ref(monthOf(day.value ?? firstDay.value ?? now));
watch(day, (picked) => {
    if (picked !== undefined && monthOf(picked) !== month.value) {
        month.value = monthOf(picked);
    }
});
const weeks = computed(() => monthWeeks(month.value, firstWeekday, now));
// Paging stops at the months holding the first and last pickable days: past them every cell would be greyed out.
const canBack = computed(() => firstDay.value === undefined || month.value > monthOf(firstDay.value));
const canOn = computed(() => lastDay.value === undefined || monthOf(month.value, 1) <= lastDay.value);
const page = (by: number): void => {
    month.value = monthOf(month.value, by);
};

const pick = (cell: MonthDay): void => {
    if (!pickable(cell.day)) {
        return;
    }
    day.value = cell.day;
    focusDay.value = cell.day;
};

/* ---- the keyboard: one Tab stop on the grid, the arrows move it (a roving tabindex, as a date grid has) ---- */

const grid = ref<HTMLElement>();
const focusDay = ref(day.value ?? firstDay.value ?? dayOf(now));
const clamp = (target: number): number =>
    Math.min(lastDay.value ?? Number.POSITIVE_INFINITY, Math.max(firstDay.value ?? Number.NEGATIVE_INFINITY, target));
const tabStop = computed(() => {
    const shown = weeks.value.flat().filter((cell) => cell.inMonth && pickable(cell.day));
    return shown.some((cell) => cell.day === focusDay.value) ? focusDay.value : (shown[0]?.day ?? focusDay.value);
});
const focusOn = async (target: number): Promise<void> => {
    focusDay.value = clamp(target);
    if (monthOf(focusDay.value) !== month.value) {
        month.value = monthOf(focusDay.value);
    }
    await nextTick();
    grid.value?.querySelector<HTMLButtonElement>(`[data-day="${focusDay.value}"]`)?.focus({ preventScroll: true });
};
const STEPS = new Map([
    [`ArrowLeft`, -1],
    [`ArrowRight`, 1],
    [`ArrowUp`, -7],
    [`ArrowDown`, 7],
]);
const onKey = (event: KeyboardEvent): void => {
    const from = tabStop.value;
    const column = (new Date(from).getDay() - firstWeekday + 7) % 7;
    let target: number | undefined;
    if (event.key === `PageUp` || event.key === `PageDown`) {
        const moved = new Date(from);
        moved.setMonth(moved.getMonth() + (event.key === `PageUp` ? -1 : 1));
        target = moved.getTime();
    } else if (event.key === `Home` || event.key === `End`) {
        target = addDays(from, event.key === `Home` ? -column : 6 - column);
    } else {
        const by = STEPS.get(event.key);
        target = by === undefined ? undefined : addDays(from, by);
    }
    if (target === undefined) {
        return;
    }
    event.preventDefault();
    void focusOn(target);
};

const dayClass = (cell: MonthDay): string => {
    if (cell.day === day.value) {
        return `bg-primary-fill font-semibold text-fill-content`;
    }
    if (!pickable(cell.day)) {
        return `cursor-default text-subtle opacity-40`;
    }
    const ink = cell.inMonth ? `text-content` : `text-subtle`;
    return cell.today ? `font-semibold text-link hover:bg-overlay` : `${ink} hover:bg-overlay`;
};
</script>

<template>
    <div class="flex flex-col gap-1">
        <div class="flex items-center gap-1 pl-1">
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-content" aria-live="polite">{{ formatMonthYear(month) }}</span>
            <button
                type="button"
                :class="ui.iconButton({ size: `md` })"
                :disabled="!canBack"
                v-tooltip.top="t(`ui.datePicker.previousMonth`)"
                :aria-label="t(`ui.datePicker.previousMonth`)"
                @click="page(-1)"
            >
                <Icon name="chevron-left" class="text-xs" />
            </button>
            <button
                type="button"
                :class="ui.iconButton({ size: `md` })"
                :disabled="!canOn"
                v-tooltip.top="t(`ui.datePicker.nextMonth`)"
                :aria-label="t(`ui.datePicker.nextMonth`)"
                @click="page(1)"
            >
                <Icon name="chevron-right" class="text-xs" />
            </button>
        </div>

        <div ref="grid" role="grid" :aria-label="formatMonthYear(month)" @keydown="onKey">
            <div role="row" class="grid grid-cols-7">
                <span v-for="cell in weeks[0]" :key="cell.day" role="columnheader" class="py-1 text-center text-3xs font-medium text-subtle">
                    {{ formatWeekday(cell.day) }}
                </span>
            </div>
            <div v-for="week in weeks" :key="week[0]?.day" role="row" class="grid grid-cols-7">
                <span v-for="cell in week" :key="cell.day" role="gridcell" :aria-selected="cell.day === day" class="flex justify-center py-px">
                    <button
                        type="button"
                        :data-day="cell.day"
                        :tabindex="cell.day === tabStop ? 0 : -1"
                        :disabled="!pickable(cell.day)"
                        :aria-label="formatDayLong(cell.day)"
                        :aria-current="cell.today ? `date` : undefined"
                        class="relative flex size-8 cursor-pointer items-center justify-center rounded-full text-xs leading-none tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-md:size-10 max-md:text-sm"
                        :class="dayClass(cell)"
                        @click="pick(cell)"
                    >
                        {{ cell.date }}
                        <span v-if="cell.today" class="absolute bottom-1 size-1 rounded-full bg-current" aria-hidden="true" />
                    </button>
                </span>
            </div>
        </div>
    </div>
</template>
