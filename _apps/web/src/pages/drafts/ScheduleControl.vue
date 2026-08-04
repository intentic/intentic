<!-- WHEN A DRAFT GOES OUT — a sentence you read, and a date input only once you ask for one.

     THIS REPLACES A COLUMN OF DATE PICKERS. Every draft row used to render a live `datetime-local`: the widest
     and loudest control on the page, drawn even on posted rows where it was empty and disabled, and stacked
     directly above the Approve button it out-weighed. Rescheduling is the rarest thing anyone does on an
     approval screen — the agent already proposed a time — so the resting state is one muted phrase and the
     input is a click away. The pencil appears on the row's hover (Row is the `group`), which is how the
     phrase advertises that it is editable without carrying chrome that says so permanently.

     SIZE AND COLOUR ARE THE CALLER'S. No text-size class here, so the same control reads as body text under a
     post being reviewed and as a small fact beside a scheduled one — the two placements it has. -->
<script setup lang="ts">
import { cmp, formatDateTime, formatTimestamp, formatWeekdayTime } from "@intentic/ui";
import { type ComponentPublicInstance, ref } from "vue";

const { at } = defineProps<{
    /** Epoch ms, or absent — a draft with no date posts as soon as the publisher picks it up. */
    at?: number;
    /** Names the row this belongs to, for the input's accessible label. */
    label: string;
}>();

// undefined clears the date rather than leaving the old one in place: an emptied field is an instruction.
const emit = defineEmits<{ change: [at: number | undefined] }>();

const editing = ref(false);

/* A calendar date alone ("Aug 5, 2026, 14:00") is unreadable at a glance over the horizon this queue works
 * across — the next few days — so anything inside a week reads as a weekday and only genuinely distant dates
 * spell themselves out. The exact instant stays in the tooltip. Local wall clock throughout: the agent bakes a
 * UTC offset into scheduledAt, so both ends agree on the instant and only the displayed clock is the viewer's. */
const WEEK = 7 * 24 * 3_600_000;
const words = (ms: number): string => {
    const ahead = ms - Date.now();
    if (ahead < 0) {
        return `Due now`;
    }
    return ahead < WEEK ? formatWeekdayTime(ms) : formatDateTime(ms);
};

// A datetime-local input speaks the browser's timezone; the draft stores epoch ms.
const pad = (n: number): string => String(n).padStart(2, `0`);
const toInput = (ms?: number): string => {
    if (ms === undefined) {
        return ``;
    }
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// The input exists only after the click, so `autofocus` (an initial-page-load attribute) would never fire.
const focusOnMount = (el: Element | ComponentPublicInstance | null): void => {
    if (el instanceof HTMLInputElement) {
        el.focus();
    }
};

const commit = (value: string): void => {
    editing.value = false;
    if (value === ``) {
        emit(`change`, undefined);
        return;
    }
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms)) {
        emit(`change`, ms);
    }
};
</script>

<template>
    <input
        v-if="editing"
        :ref="focusOnMount"
        type="datetime-local"
        :value="toInput(at)"
        :class="cmp.input(`px-2 py-1 text-xs`)"
        :aria-label="`Post ${label} at`"
        @change="commit(($event.target as HTMLInputElement).value)"
        @keydown.escape="editing = false"
        @blur="editing = false"
    />
    <button
        v-else
        type="button"
        class="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-content"
        v-tooltip.top="at === undefined ? `Posts as soon as the publisher picks it up — click to pick a date` : formatTimestamp(at)"
        @click="editing = true"
    >
        <Icon name="clock" />
        <span>{{ at === undefined ? `No date` : words(at) }}</span>
        <Icon name="pencil" class="text-2xs opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
</template>
