<!-- How an automation ends, so a watch never outlives what it was for: as it first fires, on a date, both (whichever comes first), or never. -->
<script setup lang="ts">
import { ToggleSwitch } from "@intentic/extension-ui";
import { computed } from "vue";
import { localInputOf, nextIn } from "../cronSchedule";
import { t } from "../i18n.js";
import MomentField from "./MomentField.vue";

defineProps<{
    /** Why the date cannot stand (already past), in the form's words. */
    error?: string | undefined;
    /** The date as an instant, for the line that says how far off it is. */
    at: number;
}>();
const stopAfterFirst = defineModel<boolean>("stopAfterFirst", { required: true });
// The form's spelling of a moment ("2026-11-04T09:00"); blank is no end date.
const expiresAt = defineModel<string>("expiresAt", { required: true });

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Switched on, it starts a week out at nine: a date to move, not a blank to fill before anything can be saved.
const dated = computed<boolean>({
    get: () => expiresAt.value !== ``,
    set: (on) => {
        expiresAt.value = on ? `${localInputOf(Date.now() + WEEK_MS).slice(0, 10)}T09:00` : ``;
    },
});
</script>

<template>
    <div class="flex flex-col gap-3">
        <label class="flex items-center gap-2 text-sm text-content">
            <ToggleSwitch v-model="stopAfterFirst" :aria-label="t(`automationFields.stopAfterFirstFire`)" />
            {{ t(`automationFields.stopAfterFirstFire`) }}
        </label>
        <label class="flex items-center gap-2 text-sm text-content">
            <ToggleSwitch v-model="dated" :aria-label="t(`endsFields.onDate`)" />
            {{ t(`endsFields.onDate`) }}
        </label>
        <template v-if="dated">
            <MomentField v-model="expiresAt" :min="Date.now()" />
            <p v-if="error" class="text-xs text-danger">{{ error }}</p>
            <p v-else-if="!Number.isNaN(at)" class="text-xs text-subtle">{{ t(`automationFields.endsCaption`, { when: nextIn(at) }) }}</p>
        </template>
    </div>
</template>
