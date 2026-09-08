<script setup lang="ts">
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { SegmentedControl, ui } from "@intentic/ui";
import { computed, toRef } from "vue";
import { type RunSettingsPatch, SPEED_OPTIONS, THINKING_OPTIONS, usePickerRunSettings } from "./pickerRunSettings";
import EffortMeter from "../composer/EffortMeter.vue";

/* THE ROWS FOR HOW THE MODEL IS RUN: reasoning effort, extended thinking, speed. Shared verbatim by the shell's
 * picker (HostPickerBody) and the settings page's (ModelPinPickerBody), which drew all three by hand and in
 * duplicate before this existed. The derivation behind them is pickerRunSettings.ts; this is only its markup.
 *
 * IT DRAWS ROWS AND NOT A BLOCK — no wrapper, no border, no padding. The two callers each have a footer of their
 * own with its own rule and its own 12px rhythm, and these rows fall into it beside the account list and the
 * harness axis as siblings. `hasContent` (the composable) is what tells a caller whether the footer is earned.
 *
 * EVERY ROW WRITES STRAIGHT THROUGH, one `update` patch each, and none of them closes anything. That is the
 * grammar both callers share: these are settings OF the selection, never the answer to what the panel asked. */

const emit = defineEmits<{ update: [RunSettingsPatch] }>();
const props = defineProps<{
    provider: AgentProvider;
    model: string | undefined;
    harness: AgentHarness;
    // The selection's own values, unclamped and three-state where they are three-state (see the composable).
    effort: string | undefined;
    thinking: boolean | undefined;
    fast: boolean | undefined;
}>();

const { efforts, level, thinkingOffered, fastOffered } = usePickerRunSettings(
    toRef(props, `provider`),
    toRef(props, `model`),
    toRef(props, `harness`),
    toRef(props, `thinking`),
    toRef(props, `effort`),
);

const thinkingValue = computed(() => (props.thinking === undefined ? `` : props.thinking ? `on` : `off`));
</script>

<template>
    <!-- REASONING EFFORT, the app's own meter, the same control the composer draws beside its model pill.
         "Default" is a real state rather than decoration: an unpinned effort means the work goes out without one
         and the model's own answers, so that word sits where the level would be until a rung is chosen.
         THE WAY BACK IS AN ×, NOT THE WORD AGAIN. It read "Max Default" side by side on screen — two words in
         the same size where one is the state and the other is a control, which is one phrase to anybody
         scanning the row. -->
    <div v-if="efforts.length > 0" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Reasoning effort</span>
        <span class="flex shrink-0 items-center gap-1.5">
            <EffortMeter :efforts="efforts" :effort="level" empty-label="Default" @pick="emit(`update`, { effort: $event })" />
            <!-- The × KEEPS ITS SLOT at "Default" instead of unmounting: it is the last thing on a right-aligned
                 row, so appearing on the first pick used to shove the ladder sideways out from under the cursor
                 that had just clicked it. Hidden, it is inert and unseen. -->
            <button
                type="button"
                :aria-hidden="level === `` ? `true` : undefined"
                :tabindex="level === `` ? -1 : undefined"
                :class="[ui.iconButton(`h-auto w-auto shrink-0 rounded p-1 text-subtle`), level === `` ? `pointer-events-none invisible` : ``]"
                v-tooltip.top="`Take this model's own default effort`"
                aria-label="Take this model's own default effort"
                @click="emit(`update`, { effort: undefined })"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </span>
    </div>

    <!-- CLAUDE'S TWO KNOBS. Thinking is three-stop for the reason THINKING_OPTIONS gives; speed is binary, and
         offered only where the runtime, the route and the model all allow it. -->
    <div v-if="thinkingOffered" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Extended thinking</span>
        <SegmentedControl
            :model-value="thinkingValue"
            :options="THINKING_OPTIONS"
            wrap
            @update:model-value="(value: string) => emit(`update`, { thinking: value === `` ? undefined : value === `on` })"
        />
    </div>
    <div v-if="fastOffered" class="flex items-center justify-between gap-2">
        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Speed</span>
        <SegmentedControl
            :model-value="fast === true ? `fast` : `standard`"
            :options="SPEED_OPTIONS"
            wrap
            @update:model-value="(value: string) => emit(`update`, { fast: value === `fast` ? true : undefined })"
        />
    </div>
</template>
