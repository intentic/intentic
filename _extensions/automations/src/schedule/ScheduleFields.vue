<!-- A schedule as the form and the opened automation both edit it: how often, on which days, at what time, on which clock, and how far off its next runs are. -->
<script setup lang="ts">
import { localZone, type Zone, zoneLabel } from "@intentic/sandbox-contract/time";
import { formatDateTime, TimeField, ui } from "@intentic/extension-ui";
import { computed } from "vue";
import type { ScheduleState } from "../cronSchedule";
import { t } from "../i18n.js";
import ZonePicker from "./ZonePicker.vue";

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

// One line per fact: a quiet label in a fixed column and its control, the hints under the control rather than the label.
const ROW = `flex flex-wrap items-center gap-x-3 gap-y-1.5`;
const LABEL = `w-20 shrink-0 text-xs text-subtle`;
const HINT = `text-2xs text-subtle`;

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
    <!-- Quiet label, clear control, one fact per line: the same reading order as the settings column it opens from. -->
    <div class="flex flex-col gap-3">
        <div :class="ROW">
            <span :class="LABEL">{{ t(`automationFields.repeats`) }}</span>
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
        <div v-if="schedule.freq === 'weekly'" :class="ROW">
            <span :class="LABEL">{{ t(`scheduleFields.on`) }}</span>
            <div class="flex flex-wrap gap-1.5">
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
        </div>
        <p v-if="schedule.freq === 'weekly' && schedule.days.length === 0" :class="HINT" class="text-danger">
            {{ t(`automationFields.pickAtLeastOne`) }}
        </p>
        <label v-if="schedule.freq === 'minutes'" :class="ROW">
            <span :class="LABEL">{{ t(`automationFields.every`) }}</span>
            <span class="flex items-center gap-2 text-sm text-muted">
                <input v-model.number="schedule.everyMinutes" type="number" min="1" max="59" class="w-20 tabular-nums" :class="ui.input()" />
                {{ t(`automationFields.minutes`) }}
            </span>
        </label>
        <label v-if="schedule.freq === 'monthly'" :class="ROW">
            <span :class="LABEL">{{ t(`automationFields.onDay`) }}</span>
            <input v-model.number="schedule.dayOfMonth" type="number" min="1" max="31" class="w-20 tabular-nums" :class="ui.input()" />
        </label>
        <div v-if="schedule.freq === 'daily' || schedule.freq === 'weekly' || schedule.freq === 'monthly'" :class="ROW">
            <span :class="LABEL">{{ t(`automationFields.at`) }}</span>
            <TimeField v-model="schedule.time" :aria-label="t(`automationFields.at`)" />
        </div>
        <label v-if="schedule.freq === 'custom'" :class="ROW">
            <span :class="LABEL">{{ t(`scheduleFields.cron`) }}</span>
            <input v-model="schedule.cron" placeholder="0 9 * * 1-5" class="w-48" :class="ui.input('font-mono')" />
        </label>
        <p v-if="schedule.freq === 'custom'" :class="HINT">{{ t(`automationFields.standard5FieldCron`) }}</p>
        <!-- WHICH CLOCK the times above are on. Offered wherever a schedule names an hour; "every 5 minutes" and "hourly"
             mean the same on every clock, so asking there would be noise. -->
        <div v-if="schedule.freq !== 'minutes' && schedule.freq !== 'hourly'" :class="ROW">
            <span :class="LABEL">{{ t(`scheduleFields.clock`) }}</span>
            <ZonePicker v-model="tz" :sandbox-zone="sandboxZone" />
        </div>
        <!-- Proof the cron does what it says: when it will actually fire next, on the reader's own clock. -->
        <p v-if="preview" class="text-xs">
            <span :class="'error' in preview ? 'text-danger' : 'text-muted'">
                <template v-if="'runs' in preview">{{ t(`automationFields.nextRuns`, { runs: preview.runs.map(formatDateTime).join(" · ") }) }}</template>
                <template v-else>{{ preview.error }}</template>
            </span>
            <!-- Only for a reader on a different clock from the rule, for whom the runs above read as another hour. -->
            <span v-if="previewZoneNote && 'runs' in preview" class="block text-2xs text-subtle">
                {{ t(`automationFields.shownInYourClock`, { zone: previewZoneNote }) }}
            </span>
        </p>
        <!-- Gates use sessions since the last wake, not elapsed time. -->
        <div class="border-t border-line-subtle pt-3">
            <label :class="ROW">
                <span :class="LABEL">{{ t(`scheduleFields.onlyAfter`) }}</span>
                <span class="flex flex-wrap items-center gap-2 text-sm text-muted">
                    <input
                        v-model.number="afterSessions"
                        type="number"
                        min="0"
                        class="w-20 tabular-nums"
                        :class="ui.input()"
                        :aria-label="t(`automationFields.newSessionsRequiredSince`)"
                    />
                    {{ t(`automationFields.newSessionsRunSince`) }}
                </span>
            </label>
            <p :class="HINT" class="mt-1.5">{{ t(`automationFields.n0FiresOnEvery`) }}</p>
        </div>
    </div>
</template>
