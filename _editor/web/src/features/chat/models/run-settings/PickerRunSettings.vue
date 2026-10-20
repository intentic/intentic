<script setup lang="ts">
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { computed, toRef } from "vue";
import { type RunSettingsPatch, usePickerRunSettings } from "../../../../models/providers/pickerRunSettings";
import EffortMeter from "../../composer/EffortMeter.vue";
import LoopChips from "../LoopChips.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* THE CONTROLS FOR HOW THE MODEL IS RUN, as every picker draws them: reasoning effort on a row of its own where the surface
   has no meter, then ONE toolbar: the harness and its caveats at the left end, extended thinking and speed at the right.
   No labels on the toolbar: each control's own words say what it is, and a label per row was most of the footer's text. */

const emit = defineEmits<{ update: [RunSettingsPatch]; selectHarness: [AgentHarness] }>();
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
        // OFF FOR A CALLER THAT DOES NOT CARRY RUN SETTINGS (the shell's `chooseRun`): a control whose answer is dropped on
        // the floor is worse than none, so the toolbar keeps the harness alone.
        settings?: boolean;
        // Whether the harness is this surface's to change (not another box's session), and whether it is locked for now
        // (a turn streams on it). Either way the loop is named, with its caveats.
        loopChoosable?: boolean;
        loopLocked?: boolean;
        // The harness's answer to a fast ask, where it differs from the ask: on the chip, as a mark and its hover.
        fastNotice?: string | undefined;
    }>(),
    { effortRow: true, settings: true, loopChoosable: true, loopLocked: false, fastNotice: undefined },
);

const { efforts, level, thinkingOn, thinkingOffered, fastOffered } = usePickerRunSettings(
    toRef(props, `provider`),
    toRef(props, `model`),
    toRef(props, `harness`),
    toRef(props, `thinking`),
    toRef(props, `effort`),
);

const fastOn = computed(() => props.fast === true);
const effortShown = computed(() => props.settings && props.effortRow && efforts.value.length > 0);
const chipsShown = computed(() => props.settings && (thinkingOffered.value || fastOffered.value));
</script>

<template>
    <!-- REASONING EFFORT, the app's own meter, the same control the composer draws beside its model pill. -->
    <div v-if="effortShown" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`chat.words.reasoningEffort`) }}</span>
        <EffortMeter :efforts="efforts" :effort="level" class="shrink-0" @pick="emit(`update`, { effort: $event })" />
    </div>

    <!-- THE TOOLBAR: the same shape for every provider, so the eye finds each control where it was on the last one. -->
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <LoopChips
            :provider="provider"
            :harness="harness"
            :choosable="loopChoosable"
            :disabled="loopLocked"
            @select="emit(`selectHarness`, $event)"
        />
        <div v-if="chipsShown" class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
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
                :aria-description="fastNotice"
                v-tooltip.top="fastNotice"
                @click="emit(`update`, { fast: !fastOn })"
            >
                <span class="h-1.5 w-1.5 shrink-0 rounded-full border border-current" :class="{ 'bg-current': fastOn }" aria-hidden="true"></span>
                <span>{{ t(`chat.pickerRunSettings.fastSpeed`) }}</span>
                <!-- Said only when the harness's answer differs from the ask; a notice under a working control trains people to ignore notices. -->
                <Icon v-if="fastNotice !== undefined" name="exclamation-triangle" class="shrink-0 text-warning" aria-hidden="true" />
            </button>
        </div>
    </div>
</template>
