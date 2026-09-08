<script setup lang="ts">
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { computed, toRef } from "vue";
import { type RunSettingsPatch, usePickerRunSettings } from "./pickerRunSettings";
import EffortMeter from "../composer/EffortMeter.vue";

/* THE CONTROLS FOR HOW THE MODEL IS RUN: reasoning effort, extended thinking, speed. Shared verbatim by all
 * three pickers — the shell's (HostPickerBody), the settings page's (ModelPinPickerBody) and the composer's
 * (ChatModelPicker) — which drew them by hand before this existed, the first two in duplicate and the third in
 * a control of its own. The derivation behind them is pickerRunSettings.ts; this is only its markup.
 *
 * A SCALE IS A ROW AND A SWITCH IS A CHIP, which is the whole vocabulary. Effort has six rungs and no sensible
 * chip, so it keeps a labelled row and the meter. Thinking and speed are switches, and a switch that carries
 * its own name needs no label beside it — two chips say in one line what two labelled rows said in two, and
 * the chip's own dot is the state.
 *
 * IT DRAWS ROWS AND NOT A BLOCK — no wrapper, no border, no padding. Each caller has a footer of its own with
 * its own rule and its own 12px rhythm, and these fall into it beside the account list and the harness axis as
 * siblings. `hasContent` (the composable) is what tells a caller whether the footer is earned.
 *
 * EVERY CONTROL WRITES STRAIGHT THROUGH, one `update` patch each, and none of them closes anything. That is the
 * grammar all three callers share: these are settings OF the selection, never the answer to what the panel
 * asked. The shell picker's bar is what answers there; in the composer the selection IS the live conversation. */

const emit = defineEmits<{ update: [RunSettingsPatch] }>();
/* `effortRow` CARRIES AN EXPLICIT `true`, and must: Vue casts an ABSENT Boolean prop to `false` unless the
 * declaration has a default, so leaving it to `undefined` would silently switch the row off for the two callers
 * that pass nothing. */
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
    <!-- REASONING EFFORT, the app's own meter, the same control the composer draws beside its model pill. It
         always stands on a rung: the picker has no way to say "no tier pinned", so there is nothing here to
         reset to and no × to do it with. -->
    <div v-if="effortShown" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Reasoning effort</span>
        <EffortMeter :efforts="efforts" :effort="level" class="shrink-0" @pick="emit(`update`, { effort: $event })" />
    </div>

    <!-- CLAUDE'S TWO SWITCHES. Thinking is offered wherever the provider is Claude; speed only where the
         runtime, the route and the model all allow it, so the pair is often a single chip.
         Sentence case: the uppercase style above is for a section heading, not for a control that is its own
         label. The dot is the state, and it is filled rather than coloured so the chip reads at a glance in
         both modes and on a skin that repaints the accent. -->
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
            <span>Extended thinking</span>
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
            <span>Fast speed</span>
        </button>
    </div>
</template>
