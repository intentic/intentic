<script setup lang="ts">
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { computed, toRef } from "vue";
import { type RunSettingsPatch, usePickerRunSettings } from "./pickerRunSettings";
import EffortMeter from "../composer/EffortMeter.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* THE CONTROLS FOR HOW THE MODEL IS RUN: reasoning effort, extended thinking, speed. */

const emit = defineEmits<{ update: [RunSettingsPatch] }>();
/* `effortRow` CARRIES AN EXPLICIT `true`, and must: Vue casts an ABSENT Boolean prop to `false` unless the declaration has a default. */
const props = withDefaults(
    defineProps<{
        provider: AgentProvider;
        model: string | undefined;
        harness: AgentHarness;
        // The selection's own values. Optional because a selection minted by a route or an extension never came
        // through a picker; `runSettingsOf` resolves those to a state rather than drawing an absence.
        effort: string | undefined;
        thinking: boolean | undefined;
        fast: boolean | undefined;
        // OFF ONLY FOR A SURFACE THAT ALREADY DRAWS THE METER: the chat composer keeps one beside the model pill,
        // an inch from the chevron that opens this panel, so its picker would be showing the same control twice.
        // Nothing else may switch a control off — a question the caller can answer belongs in the caller.
        effortRow?: boolean;
    }>(),
    { effortRow: true },
);

const { efforts, level, thinkingOn, thinkingOffered, fastOffered } = usePickerRunSettings(
    toRef(props, `provider`),
    toRef(props, `model`),
    toRef(props, `harness`),
    toRef(props, `thinking`),
    toRef(props, `effort`),
);

const fastOn = computed(() => props.fast === true);
const effortShown = computed(() => props.effortRow && efforts.value.length > 0);
// One chip line, drawn only when there is a chip to put on it.
const chipsShown = computed(() => thinkingOffered.value || fastOffered.value);
</script>

<template>
    <!-- REASONING EFFORT, the app's own meter, the same control the composer draws beside its model pill. -->
    <div v-if="effortShown" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`chat.pickerRunSettings.reasoningEffort`) }}</span>
        <EffortMeter :efforts="efforts" :effort="level" class="shrink-0" @pick="emit(`update`, { effort: $event })" />
    </div>

    <!-- CLAUDE'S TWO SWITCHES. -->
    <div v-if="chipsShown" class="flex flex-wrap items-center gap-1.5">
        <button
            v-if="thinkingOffered"
            type="button"
            class="composer-ghost composer-toggle h-7 gap-1.5 px-2.5 text-2xs font-medium max-md:h-10"
            :class="{ 'composer-active': thinkingOn }"
            :aria-pressed="thinkingOn"
            @click="emit(`update`, { thinking: !thinkingOn })"
        >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full border border-current" :class="{ 'bg-current': thinkingOn }" aria-hidden="true"></span>
            <span>{{ t(`chat.pickerRunSettings.extendedThinking`) }}</span>
        </button>
        <button
            v-if="fastOffered"
            type="button"
            class="composer-ghost composer-toggle h-7 gap-1.5 px-2.5 text-2xs font-medium max-md:h-10"
            :class="{ 'composer-active': fastOn }"
            :aria-pressed="fastOn"
            @click="emit(`update`, { fast: !fastOn })"
        >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full border border-current" :class="{ 'bg-current': fastOn }" aria-hidden="true"></span>
            <span>{{ t(`chat.pickerRunSettings.fastSpeed`) }}</span>
        </button>
    </div>
</template>
