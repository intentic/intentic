<script setup lang="ts">
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { SectionHeader } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
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
    <!-- ONE BLOCK UNDER ONE RULE spanning the panel whenever anything stands above it in the footer (PickerFooter), so the
         controls for how the model runs read as the footer's last group rather than more account rows. -->
    <div class="-mx-3 flex flex-col gap-2 px-3 py-2 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-line">
        <!-- REASONING EFFORT, the app's own meter, the same control the composer draws beside its model pill. -->
        <SectionHeader v-if="effortShown" :label="t(`chat.words.reasoningEffort`)" density="dense">
            <template #actions>
                <EffortMeter :efforts="efforts" :effort="level" class="shrink-0" @pick="emit(`update`, { effort: $event })" />
            </template>
        </SectionHeader>

        <!-- THE TOOLBAR: the same shape for every provider, so the eye finds each control where it was on the last one. -->
        <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
            <LoopChips
                :provider="provider"
                :harness="harness"
                :choosable="loopChoosable"
                :disabled="loopLocked"
                @select="emit(`selectHarness`, $event)"
            />
            <!-- EACH SETTING IS ITS NAME AND THE APP'S OWN SWITCH, the whole label pressing it. It was a pill holding a dot and a
                 second pill saying On or Off: a box in a box, three marks for one bit, and lit in the accent beside the
                 picked model and account. The switch says the state on its own, in every look, and a screen reader hears a
                 switch named by its words. -->
            <div v-if="chipsShown" class="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5">
                <label v-if="thinkingOffered" class="flex cursor-pointer items-center gap-2 text-2xs text-muted transition-colors hover:text-content max-md:min-h-11">
                    <span data-switch-name>{{ t(`chat.pickerRunSettings.extendedThinking`) }}</span>
                    <ToggleSwitch class="ui-switch-xs shrink-0" :model-value="thinkingOn" @update:model-value="(on: boolean) => emit(`update`, { thinking: on })" />
                </label>
                <label
                    v-if="fastOffered"
                    class="flex cursor-pointer items-center gap-2 text-2xs text-muted transition-colors hover:text-content max-md:min-h-11"
                    v-tooltip.top="fastNotice"
                >
                    <span data-switch-name>{{ t(`chat.pickerRunSettings.fastSpeed`) }}</span>
                    <!-- Said only when the harness's answer differs from the ask; a notice under a working control trains people to ignore notices. -->
                    <template v-if="fastNotice !== undefined">
                        <Icon name="exclamation-triangle" class="shrink-0 text-warning" aria-hidden="true" />
                        <span class="sr-only">{{ fastNotice }}</span>
                    </template>
                    <ToggleSwitch class="ui-switch-xs shrink-0" :model-value="fastOn" @update:model-value="(on: boolean) => emit(`update`, { fast: on })" />
                </label>
            </div>
        </div>
    </div>
</template>
