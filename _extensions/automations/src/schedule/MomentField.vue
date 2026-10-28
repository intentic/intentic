<!-- One moment on the reader's own clock, as a day off the month's grid and a time of day beside it: when a one-time wake fires, or when an automation ends. -->
<script setup lang="ts">
import { DatePicker, TimeField } from "@intentic/extension-ui";
import { computed } from "vue";
import { localInputOf } from "../cronSchedule";
import { t } from "../i18n.js";

const { min, time: defaultTime = `09:00` } = defineProps<{
    /** The first moment that may be picked; days before it cannot be pressed. */
    min?: number | undefined;
    /** The time a day picked alone takes. */
    time?: string;
}>();

// The form's own spelling of a moment ("2026-10-28T09:00", as `datetime-local` wrote it and `instantOf` reads it), so
// nothing about what is stored changes with the control that edits it. Blank until both halves are known.
const moment = defineModel<string>({ required: true });

const pad = (value: number): string => String(value).padStart(2, `0`);
const day = computed<number | undefined>({
    get: () => {
        if (moment.value === ``) {
            return undefined;
        }
        const at = new Date(`${moment.value.slice(0, 10)}T00:00`).getTime();
        return Number.isNaN(at) ? undefined : at;
    },
    set: (picked) => {
        if (picked === undefined) {
            moment.value = ``;
            return;
        }
        moment.value = `${localInputOf(picked).slice(0, 10)}T${clock.value === `` ? defaultTime : clock.value}`;
    },
});
const clock = computed<string>({
    get: () => moment.value.slice(11, 16),
    set: (typed) => {
        if (typed === ``) {
            return;
        }
        // A time typed before a day is picked lands on the first day it can: today, or tomorrow once it has passed.
        const on = day.value ?? new Date().setHours(0, 0, 0, 0);
        const [hours = 0, minutes = 0] = typed.split(`:`).map(Number);
        let at = new Date(on).setHours(hours, minutes, 0, 0);
        if (day.value === undefined && at <= Date.now()) {
            const next = new Date(at);
            next.setDate(next.getDate() + 1);
            at = next.getTime();
        }
        moment.value = `${localInputOf(at).slice(0, 10)}T${pad(hours)}:${pad(minutes)}`;
    },
});
</script>

<template>
    <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
        <DatePicker v-model="day" :min="min" class="w-64" />
        <label class="flex flex-col gap-1">
            <span class="text-xs text-subtle">{{ t(`automationFields.at`) }}</span>
            <TimeField v-model="clock" :aria-label="t(`momentField.time`)" />
        </label>
    </div>
</template>
