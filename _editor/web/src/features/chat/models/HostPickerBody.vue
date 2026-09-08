<script setup lang="ts">
import { Button } from "@intentic/ui";
import { computed } from "vue";
import { commitModelPick, dismissModelPick, modelRequest, stageModelPick } from "./hostModelPicker";
import { effortLabelOf } from "./effortScale";
import { modelLabelFor } from "../accounts/providerCatalog";
import type { PickerEntry } from "./modelPickerState";
import { usePickerAccounts } from "../accounts/pickerAccounts";
import { usePickerRunSettings } from "./pickerRunSettings";
import ModelPicker from "./ModelPicker.vue";
import PickerAccounts from "../accounts/PickerAccounts.vue";
import PickerRunSettings from "./PickerRunSettings.vue";

/* THE SHELL PICKER'S BODY: the list, the who-serves-the-turn block the composer shows, the model's own run
 * settings, and the button that ends the whole thing. One component because there are two hosts for it (a sheet
 * on mobile, a popover on desktop) and only the frame differs.
 *
 * A MODEL ROW SELECTS HERE; THE BAR AT THE BOTTOM COMMITS. That is the one real difference from the composer's
 * binding of this same list, and hostModelPicker.ts has the argument for it in full: every caller of this panel
 * is AWAITING an answer, and several of them spend money on it, so an answer has to be a press on something that
 * names what will happen rather than a click on a row in a list you were reading.
 *
 * It also makes the panel cancellable. When a row settled it, the only way to leave after touching the effort
 * meter was to click away — which the old version had to treat as an answer to keep the meter from looking
 * broken, so backing out of a change ARMED it. Now every row writes through freely, because Escape undoes all of
 * it at once.
 *
 * THE RUN SETTINGS ARE HERE FOR THE SAME REASON THE SETTINGS PAGE HAS THEM (ModelPinPickerBody), and they are
 * the same three rows, from the same composable: this panel is what every "Fix with agent" caret opens, and a
 * run started from a red pipeline has no composer beside it to set a tier in. Without them the caret could move
 * the run to a frontier model and not to the tier that model was pinned at, which is half of what the standing
 * setting says and the cheaper half. */

const request = computed(() => modelRequest.value);

// The block below the list: mounted only when it has something to say, since the border and padding are drawn
// here rather than by it.
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

/* NOTHING IS CHOSEN YET is a real state this panel opens in: an automation rung added past the end of its
 * ladder arrives with a blank pair, and there is no such thing as half an entry. The bar refuses the press
 * until the list has been answered, which is the one thing the list is unambiguously for. */
const chosen = computed(() => {
    const held = request.value;
    return held !== undefined && held.provider !== `` && held.model !== ``;
});

/* WHAT THE PRESS COSTS, in the one line above it: the model, and the tier it will think at where one is pinned.
 * The list is scrollable and usually scrolled, so the checkmark answering "which model" is routinely off screen
 * by the time somebody reaches the bottom of the panel — this is the only place the selection is named in words
 * at the moment it is spent. The tier is read the way the daemon will read it (against this selection's own
 * thinking), so the line cannot promise a rung the run will not use. */
const spend = computed<string>(() => {
    const held = request.value;
    if (held === undefined || !chosen.value) {
        return `Choose a model to continue`;
    }
    const tier = held.chooseRun === true ? effortLabelOf(held.effort, held.provider, held.model, held.thinking) : undefined;
    return [modelLabelFor(held.provider, held.model), ...(tier === undefined ? [] : [tier])].join(` · `);
});

/* A model row STAGES. Account and harness ride along ONLY under the provider they were made under: an account id
 * is one provider's store key, and a harness is a choice that exists for codex/grok alone, so carrying either
 * across a provider switch would pin the work to a credential the new provider does not have. THE RUN SETTINGS
 * TRAVEL, because effort, thinking and speed are questions every native model answers for itself, and the
 * meter's own clamp already says what a shorter scale will run a carried tier at — the same split the settings
 * page's picker makes. */
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
        @submit="commitModelPick()"
        @close="dismissModelPick()"
    >
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

        <!-- THE END OF THE PANEL, and the whole reason it now has one. It is `shrink-0` because it is the row
             that may never be squeezed out by a tall footer on a short window, and `sticky bottom-0` because the
             mobile sheet scrolls as one piece: unstuck, the press this panel exists for would sit below the fold
             on exactly the device where the accounts list is longest.
             THE VERB IS THE CALLER'S ("Fix with agent", "Run chore", "Use this model"), because only the caller
             knows what the press does, and the line above it is what that press will spend. -->
        <template #commit>
            <div class="sticky bottom-0 z-10 flex shrink-0 flex-col gap-1.5 border-t border-line bg-canvas px-3 py-2">
                <span class="truncate text-2xs" :class="chosen ? `text-subtle` : `text-muted`">{{ spend }}</span>
                <Button
                    :label="request.action"
                    class="w-full"
                    :disabled="!chosen"
                    v-tooltip.top="`${request.action} — ⌘/Ctrl + Enter`"
                    @click="commitModelPick()"
                >
                    <template #icon><Icon name="play" /></template>
                </Button>
            </div>
        </template>
    </ModelPicker>
</template>
