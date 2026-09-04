<script setup lang="ts">
import { capabilitiesOf, sendableEffort } from "@intentic/sandbox-contract";
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { clampEffort, effortsFor } from "../composables/chat/effortScale";
import { modelRequest, settleModelPick, stageModelPick } from "../composables/chat/hostModelPicker";
import type { PickerEntry } from "../composables/chat/modelPicker";
import { usePickerAccounts } from "../composables/chat/pickerAccounts";
import EffortMeter from "./EffortMeter.vue";
import ModelPicker from "./ModelPicker.vue";
import PickerAccounts from "./PickerAccounts.vue";

/* THE SHELL PICKER'S BODY: the list, and under it the same who-serves-the-turn block the composer shows. One
 * component because there are two hosts for it (a sheet on mobile, a popover on desktop) and only the frame
 * differs; the panel they frame is the same panel, and it stopped being a single tag the moment it grew a footer.
 *
 * Like the composer, only a MODEL row answers and closes. Account, harness and effort rows configure that answer
 * in place: the open request holds those staged pins until a model is picked, while dismissal still returns no
 * choice to the caller.
 *
 * THE EFFORT ROW IS HERE FOR THE SAME REASON THE SETTINGS PAGE HAS ONE (ModelPinPickerBody), and it is the same
 * control: this panel is what every "Fix with agent" caret opens, and a run started from a red pipeline has no
 * composer beside it to set a tier in. Without it the caret could move the run to a frontier model and not to
 * the tier that model was pinned at, which is half of what the standing setting says and the cheaper half. */

const request = computed(() => modelRequest.value);

// The block below the list: mounted only when it has something to say, since the border and padding are drawn
// here rather than by it.
const { hasContent } = usePickerAccounts(
    computed(() => request.value?.provider ?? `claude`),
    computed(() => request.value?.harness ?? `native`),
    computed(() => request.value?.model),
);

/* WHICH RUNGS THIS SELECTION OFFERS, and whether it is asked at all: `chooseEffort` is the caller saying it
 * carries a tier (every run button does; the chat, the automations form and a workflow step do not).
 *
 * THINKING IS NOT PART OF A RUN PICK, and the scale is read with it UNSET rather than off, which is the same
 * reading the daemon will make of a turn that says nothing about thinking. Passing `false` here is what used to
 * take Claude's top rung off this panel: `max` is refused only alongside thinking that was explicitly turned
 * OFF, and a run started from a red pipeline turns nothing off — it pins a model and a tier, and the daemon
 * names the reasoning that tier needs on the way out (sendableThinking). A runtime that owns its own reasoning
 * settings (ACP, OpenCode) publishes no scale and draws no row either. */
const efforts = computed(() => {
    const held = request.value;
    if (held?.chooseEffort !== true || !capabilitiesOf(held.provider, held.harness ?? `native`).effort) {
        return [];
    }
    return effortsFor(held.provider, held.model, undefined);
});

/* THE TIER THIS RUN IS ON, read the one way the daemon will read it (sendableEffort over the same unset
 * thinking): nothing is repaired for a pick that turned nothing off, so a run pinned at Max opens on Max.
 * Reading it here rather than only on the way out is what keeps the meter honest — a panel lighting a rung the
 * turn will not use is the failure this control exists to prevent. */
const staged = computed(() => sendableEffort(request.value?.effort, undefined));

/* CLAMPED FOR DISPLAY on top of that, never written back, the composer's own rule (effortScale.ts): a tier
 * carried over from a model with a longer scale would otherwise light no rung at all and read as an unset
 * control. What the run SENDS stays the repaired pick, for the day they re-point it at a longer scale again. */
const effort = computed(() => {
    const held = request.value;
    return staged.value === undefined || staged.value === `` || held === undefined
        ? ``
        : clampEffort(staged.value, held.provider, held.model, undefined);
});

const footerVisible = computed(() => hasContent.value || efforts.value.length > 0);

/* A model row. Account and harness ride along ONLY under the provider they were made under: an account id is one
 * provider's store key, and a harness is a choice that exists for codex/grok alone, so carrying either across a
 * provider switch would pin the run to a credential the new provider does not have. THE EFFORT TRAVELS, because
 * a tier is a question every native model answers, and the clamp above already says what a shorter scale will
 * run it at, the same split the settings page's picker makes. */
const choose = (entry: PickerEntry): void => {
    const held = request.value;
    const kept = held !== undefined && entry.provider === held.provider ? held : undefined;
    settleModelPick({
        provider: entry.provider,
        model: entry.value,
        label: entry.label,
        ...(kept?.account !== undefined ? { account: kept.account } : {}),
        ...(kept?.harness !== undefined ? { harness: kept.harness } : {}),
        ...(staged.value === undefined || staged.value === `` ? {} : { effort: staged.value }),
    });
};
</script>

<template>
    <ModelPicker v-if="request" :provider="request.provider" :model="request.model" @pick="choose" @close="settleModelPick()">
        <template #footer>
            <!-- The composer's footer metrics exactly (ModelPicker's own 12px rhythm, the row groups bleeding
                 back out with `-mx-3`): the two panels are the same panel, and a reader who opens this one from
                 an extension should not be able to tell which surface asked for it. -->
            <div
                v-if="footerVisible"
                class="scrollbar-thin flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2"
            >
                <PickerAccounts
                    v-if="hasContent"
                    :provider="request.provider"
                    :harness="request.harness ?? `native`"
                    :model="request.model"
                    :account="request.account"
                    @select-account="stageModelPick({ account: $event })"
                    @select-harness="stageModelPick({ harness: $event })"
                    @navigate="settleModelPick()"
                />

                <!-- REASONING EFFORT, the app's own meter, drawn exactly as Sandbox ▸ Agent ▸ Models draws it for
                     a pinned entry: "Default" is a real state rather than decoration (the run goes out without an
                     effort and the model's own answers), and the way back to it is the × rather than the word
                     again, which read as one phrase beside the level it was meant to undo. -->
                <div v-if="efforts.length > 0" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Reasoning effort</span>
                    <span class="flex shrink-0 items-center gap-1.5">
                        <EffortMeter :efforts="efforts" :effort="effort" empty-label="Default" @pick="stageModelPick({ effort: $event })" />
                        <!-- The × KEEPS ITS SLOT at "Default" instead of unmounting: it is the last thing on a
                             right-aligned row, so appearing on the first pick used to shove the ladder sideways
                             out from under the cursor that had just clicked it. Hidden, it is inert and unseen. -->
                        <button
                            type="button"
                            :aria-hidden="effort === `` ? `true` : undefined"
                            :tabindex="effort === `` ? -1 : undefined"
                            :class="[ui.iconButton(`h-auto w-auto shrink-0 rounded p-1 text-subtle`), effort === `` ? `pointer-events-none invisible` : ``]"
                            v-tooltip.top="`Take this model's own default effort`"
                            aria-label="Take this model's own default effort"
                            @click="stageModelPick({ effort: undefined })"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </span>
                </div>
            </div>
        </template>
    </ModelPicker>
</template>
