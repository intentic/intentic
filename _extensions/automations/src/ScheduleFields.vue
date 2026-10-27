<!-- A schedule as the form and the opened automation both edit it: how often, on which days, at what time, on which clock, and how far off its next runs are. -->
<script setup lang="ts">
import { localZone, type Zone, zoneLabel } from "@intentic/sandbox-contract/time";
import { formatDateTime, ui } from "@intentic/extension-ui";
import { computed } from "vue";
import type { ScheduleState } from "./cronSchedule";
import { t } from "./i18n.js";

const props = defineProps<{
    // Edited in place, as the form's own reactive schedule is: the caller composes the cron from it (cronOf).
    schedule: ScheduleState;
    // When it fires next, or why it never will (cronSchedule.ts `previewOf`).
    preview: { runs: number[] } | { error: string } | undefined;
    /** The clock its times are on: its own override, else the sandbox's. */
    zone: Zone;
    /** The sandbox's own clock, which a blank override means. */
    sandboxZone: Zone;
}>();
// Blank is not "no zone", it is the sandbox's own; 0 sessions fires on every occurrence.
const tz = defineModel<string>("tz", { required: true });
const afterSessions = defineModel<number>("afterSessions", { required: true });

// Every zone ICU knows, which is the only list that cannot go stale against the runtime that will resolve it. Built
// once: it is ~450 strings and the picker is opened rarely.
const ZONE_OPTIONS = Intl.supportedValuesOf(`timeZone`);

// Names the rule's zone beside the preview when the reader is not on that clock, and stays quiet when they are. The
// preview itself is formatted in the READER's zone deliberately — "when does this happen to me" is the question a
// preview answers — and without this line a 20:43 Warsaw rule would read "22:43" to a reader in London with nothing
// on screen explaining the two hours.
const previewZoneNote = computed(() => zoneLabel(props.zone, localZone()));

const FREQ_OPTIONS = computed(
    () =>
        [
            { value: `minutes`, label: t(`automationFields.minutes2`) },
            { value: `hourly`, label: t(`automationFields.hourly`) },
            { value: `daily`, label: t(`automationFields.daily`) },
            { value: `weekly`, label: t(`automationFields.weekly`) },
            { value: `monthly`, label: t(`automationFields.monthly`) },
            { value: `custom`, label: t(`automationFields.custom`) },
        ] as const,
);
const DAY_OPTIONS = computed(
    () =>
        [
            { value: 1, label: t(`automationFields.mon`) },
            { value: 2, label: t(`automationFields.tue`) },
            { value: 3, label: t(`automationFields.wed`) },
            { value: 4, label: t(`automationFields.thu`) },
            { value: 5, label: t(`automationFields.fri`) },
            { value: 6, label: t(`automationFields.sat`) },
            { value: 0, label: t(`automationFields.sun`) },
        ] as const,
);

const toggleDay = (day: number): void => {
    const at = props.schedule.days.indexOf(day);
    if (at === -1) {
        props.schedule.days.push(day);
        return;
    }
    props.schedule.days.splice(at, 1);
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <div class="ui-field">
            <span class="ui-field-label">{{ t(`automationFields.repeats`) }}</span>
            <div class="flex flex-wrap gap-1.5">
                <button
                    v-for="option in FREQ_OPTIONS"
                    :key="option.value"
                    type="button"
                    :class="ui.chip({ on: schedule.freq === option.value })"
                    :aria-pressed="schedule.freq === option.value"
                    @click="schedule.freq = option.value"
                >
                    {{ option.label }}
                </button>
            </div>
        </div>
        <!-- One wrapping row, not stacked, since "Mon…Sun" and "At 09:00" are also spoken side by side. -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div v-if="schedule.freq === 'weekly'" class="flex flex-wrap gap-1.5">
                <button
                    v-for="day in DAY_OPTIONS"
                    :key="day.value"
                    type="button"
                    :class="ui.chip({ on: schedule.days.includes(day.value) })"
                    :aria-pressed="schedule.days.includes(day.value)"
                    @click="toggleDay(day.value)"
                >
                    {{ day.label }}
                </button>
            </div>
            <label v-if="schedule.freq === 'minutes'" class="flex items-center gap-2 text-xs text-muted">
                {{ t(`automationFields.every`) }}
                <input v-model.number="schedule.everyMinutes" type="number" min="1" max="59" class="w-20" :class="ui.input()" />
                {{ t(`automationFields.minutes`) }}
            </label>
            <label v-if="schedule.freq === 'monthly'" class="flex items-center gap-2 text-xs text-muted">
                {{ t(`automationFields.onDay`) }}
                <input v-model.number="schedule.dayOfMonth" type="number" min="1" max="31" class="w-20" :class="ui.input()" />
            </label>
            <label
                v-if="schedule.freq === 'daily' || schedule.freq === 'weekly' || schedule.freq === 'monthly'"
                class="flex items-center gap-2 text-xs text-muted"
            >
                <!-- Wide enough for a 12-hour locale: `w-28` clipped the AM/PM suffix in en-US browsers. -->
                {{ t(`automationFields.at`) }} <input v-model="schedule.time" type="time" class="w-36" :class="ui.input()" />
            </label>
            <label v-if="schedule.freq === 'custom'" class="flex min-w-0 flex-col gap-1">
                <input v-model="schedule.cron" placeholder="0 9 * * 1-5" class="w-48" :class="ui.input('font-mono')" />
                <span class="text-2xs text-subtle">{{ t(`automationFields.standard5FieldCron`) }}</span>
            </label>
            <!-- WHICH CLOCK the times above are on. Offered wherever a schedule names an hour; "every 5
                 minutes" and "hourly" mean the same on every clock, so asking there would be noise.
                 The blank option is not "no zone", it is the sandbox's own, so moving that one setting
                 moves every schedule that never asked for something else. -->
            <label
                v-if="schedule.freq !== 'minutes' && schedule.freq !== 'hourly'"
                class="flex items-center gap-2 text-xs text-muted"
            >
                {{ t(`automationFields.inZone`) }}
                <select v-model="tz" class="w-52" :class="ui.input()">
                    <option value="">{{ t(`automationFields.sandboxClock`, { zone: sandboxZone }) }}</option>
                    <option v-for="zone in ZONE_OPTIONS" :key="zone" :value="zone">{{ zone }}</option>
                </select>
            </label>
        </div>
        <p v-if="schedule.freq === 'weekly' && schedule.days.length === 0" class="text-xs text-danger">
            {{ t(`automationFields.pickAtLeastOne`) }}
        </p>
        <!-- Proof the cron does what it says: shows when it will actually fire next. -->
        <p v-if="preview" class="text-xs" :class="'error' in preview ? 'text-danger' : 'text-muted'">
            <template v-if="'runs' in preview">{{
                t(`automationFields.nextRuns`, { runs: preview.runs.map(formatDateTime).join(" · ") })
            }}</template>
            <template v-else>{{ preview.error }}</template>
        </p>
        <!-- Shown only to a reader on a different clock from the rule, for whom the preview above reads as
             a different hour than the one they typed. -->
        <p v-if="previewZoneNote && preview && 'runs' in preview" class="text-2xs text-subtle">
            {{ t(`automationFields.shownInYourClock`, { zone: previewZoneNote }) }}
        </p>
        <!-- Gates use sessions since the last wake, not elapsed time. -->
        <label class="flex flex-wrap items-center gap-2 text-xs text-muted">
            {{ t(`automationFields.onlyOnce`) }}
            <input
                v-model.number="afterSessions"
                type="number"
                min="0"
                class="w-20 font-mono"
                :class="ui.input()"
                :aria-label="t(`automationFields.newSessionsRequiredSince`)"
            />
            {{ t(`automationFields.newSessionsRunSince`) }}
        </label>
        <p class="text-2xs text-subtle">
            {{ t(`automationFields.n0FiresOnEvery`) }}
        </p>
    </div>
</template>
