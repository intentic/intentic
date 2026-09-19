<script setup lang="ts">
import { Button } from "@intentic/ui";
import { computed } from "vue";
import { commitModelPick, dismissModelPick, modelRequest, stageModelPick } from "./hostModelPicker";
import { effortLabelOf } from "../run-settings/effortScale";
import { modelLabelFor } from "../../accounts/providerCatalog";
import type { PickerEntry } from "../modelPickerState";
import { usePickerAccounts } from "../../accounts/pickerAccounts";
import { usePickerRunSettings } from "../run-settings/pickerRunSettings";
import ModelPicker from "../ModelPicker.vue";
import PickerAccounts from "../../accounts/PickerAccounts.vue";
import PickerRunSettings from "../run-settings/PickerRunSettings.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The shell picker contains choices, run settings, and its commit action. */

const request = computed(() => modelRequest.value);

// Mounted only when the block has something to say; border and padding are drawn here, not by it.
const { hasContent } = usePickerAccounts(
    computed(() => request.value?.provider ?? `claude`),
    computed(() => request.value?.harness ?? `native`),
    computed(() => request.value?.model),
);

// And the same question for the run settings, whose rows are drawn only for a caller that CARRIES them
// (`chooseRun`): a control whose answer is dropped on the floor is worse than no control.
const { hasContent: runSettingsShown } = usePickerRunSettings(
    computed(() => request.value?.provider ?? `claude`),
    computed(() => request.value?.model),
    computed(() => request.value?.harness ?? `native`),
    computed(() => request.value?.thinking),
    computed(() => request.value?.effort),
);
const runSettings = computed(() => request.value?.chooseRun === true && runSettingsShown.value);

const footerVisible = computed(() => hasContent.value || runSettings.value);

/* THE VERB THE KEYBOARD'S SUBMIT MEANS when the bar carries two: the safe one, Continue, wherever it is offered. */
const defaultResume = computed(() => {
    const attempt = request.value?.attempt;
    return attempt === undefined ? undefined : attempt.continuable ? `continue` : `start-over`;
});

/* NOTHING IS CHOSEN YET is a real state this panel opens in: an automation rung added past the end of its ladder arrives with a blank pair. */
const chosen = computed(() => {
    const held = request.value;
    return held !== undefined && held.provider !== `` && held.model !== ``;
});

/* WHAT THE PRESS COSTS, in the one line above it: the model, and the tier it will think at where one is pinned. */
const spend = computed<string>(() => {
    const held = request.value;
    if (held === undefined || !chosen.value) {
        return `Choose a model to continue`;
    }
    const tier = held.chooseRun === true ? effortLabelOf(held.effort, held.provider, held.model, held.thinking) : undefined;
    return [modelLabelFor(held.provider, held.model), ...(tier === undefined ? [] : [tier])].join(` · `);
});

/* A model row STAGES. */
const choose = (entry: PickerEntry): void => {
    const held = request.value;
    const switching = held !== undefined && entry.provider !== held.provider;
    stageModelPick({
        provider: entry.provider,
        model: entry.value,
        ...(switching ? { account: undefined, harness: undefined } : {}),
    });
};
</script>

<template>
    <ModelPicker
        v-if="request"
        :provider="request.provider"
        :model="request.model"
        @pick="choose"
        @submit="commitModelPick(defaultResume)"
        @close="dismissModelPick()"
    >
        <template #footer>
            <!-- Picker and composer share the footer metrics. -->
            <div v-if="footerVisible" class="flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2">
                <PickerAccounts
                    v-if="hasContent"
                    :provider="request.provider"
                    :harness="request.harness ?? `native`"
                    :model="request.model"
                    :account="request.account"
                    @select-account="stageModelPick({ account: $event })"
                    @select-harness="stageModelPick({ harness: $event })"
                    @navigate="dismissModelPick()"
                />

                <PickerRunSettings
                    v-if="runSettings"
                    :provider="request.provider"
                    :model="request.model"
                    :harness="request.harness ?? `native`"
                    :effort="request.effort"
                    :thinking="request.thinking"
                    :fast="request.fast"
                    @update="stageModelPick($event)"
                />
            </div>
        </template>

        <!-- THE END OF THE PANEL, and the whole reason it now has one. -->
        <template #commit>
            <div class="sticky bottom-0 z-10 flex shrink-0 flex-col gap-1.5 border-t border-line bg-canvas px-3 py-2">
                <span class="truncate text-2xs" :class="chosen ? `text-subtle` : `text-muted`">{{ spend }}</span>
                <!-- OVER AN ATTEMPT, THE BAR IS ABOUT THE ATTEMPT (hostModelPicker.ts, AttemptOnOffer): the line names it and the verbs say what the press does to it. -->
                <template v-if="request.attempt">
                    <p class="truncate text-2xs text-muted" :title="request.attempt.summary">{{ request.attempt.summary }}</p>
                    <div class="flex gap-1.5">
                        <Button
                            v-if="request.attempt.continuable"
                            :label="t(`ui.action.continue`)"
                            class="flex-1"
                            :disabled="!chosen"
                            v-tooltip.top="t(`chat.hostPickerBody.carriesOnInSame`)"
                            @click="commitModelPick(`continue`)"
                        >
                            <template #icon><Icon name="play" /></template>
                        </Button>
                        <Button
                            :label="t(`chat.hostPickerBody.startOver`)"
                            class="flex-1"
                            :severity="request.attempt.continuable ? `secondary` : undefined"
                            :disabled="!chosen"
                            v-tooltip.top="
                                request.attempt.continuable
                                    ? t(`chat.hostPickerBody.filesAttemptAwayOpens`)
                                    : t(`chat.hostPickerBody.stopsFilesAttemptAway`)
                            "
                            @click="commitModelPick(`start-over`)"
                        >
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                    </div>
                </template>
                <Button
                    v-else
                    :label="request.action"
                    class="w-full"
                    :disabled="!chosen"
                    v-tooltip.top="t(`chat.hostPickerBody.ctrlEnter`, { action: request.action })"
                    @click="commitModelPick()"
                >
                    <template #icon><Icon name="play" /></template>
                </Button>
            </div>
        </template>
    </ModelPicker>
</template>
