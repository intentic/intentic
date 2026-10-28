<script setup lang="ts">
import { Button, type IconName, type Tip, useNow } from "@intentic/ui";
import { computed } from "vue";
import { commitModelPick, dismissModelPick, modelRequest, stageModelPick } from "../../../../models/conversations/accounts/hostModelPicker";
import { effortLabelOf } from "../../../../models/providers/effortScale";
import { modelLabelFor } from "../../../../models/providers/providerCatalog";
import type { PickerEntry } from "../../../../models/conversations/accounts/modelPickerState";
import { usePickerAccounts } from "../../accounts/pickerAccounts";
import { usePickerRunSettings } from "../../../../models/providers/pickerRunSettings";
import ModelPicker from "../ModelPicker.vue";
import PickerAccounts from "../../accounts/PickerAccounts.vue";
import PickerRunSettings from "../run-settings/PickerRunSettings.vue";
import PickerStatus from "../../accounts/PickerStatus.vue";
import { loopRowShown, offeredLoops } from "../../../../models/providers/offeredLoops";
import { formatChord, isApplePlatform } from "../../../../workbench/commands/keybindings";
import { runAllowance } from "../../../../models/conversations/accounts/shellModelPicking";
import { atReopenPhrase } from "../../../../models/conversations/endings/pickUp";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The shell picker contains choices, run settings, and its commit action. */

const request = computed(() => modelRequest.value);

// Mounted only when the block has something to say; border and padding are drawn here, not by it.
const { hasContent, unplacedRefusal } = usePickerAccounts(
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

// The harness row: a choice where the provider has several loops, and the loop's limits and vendor terms either way.
const loopShown = computed(
    () =>
        request.value !== undefined && loopRowShown(request.value.provider, offeredLoops(request.value.provider), request.value.harness ?? `native`),
);
const runShown = computed(() => loopShown.value || runSettings.value);

const footerVisible = computed(() => hasContent.value || unplacedRefusal.value !== undefined || runShown.value);

/* THE KEYBOARD'S SUBMIT, drawn on the one verb it presses (defaultResume): ⌘Enter on a Mac, Ctrl+Enter elsewhere. */
const submitKeys = formatChord(`Mod+Enter`, isApplePlatform());

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

/* WHAT A RUN ON THE STAGED PICK WOULD MEET IF IT STARTED NOW: its allowance spent until a reopen (runServing.ts), by the rule the button beside the panel and the composer's Send read. Ticks while the panel is open, as it is mounted only then. */
const now = useNow(true, 30_000);
const spent = computed(() => {
    const held = request.value;
    return held === undefined || !chosen.value ? undefined : runAllowance(held, now.value);
});
// Only a caller whose press books such a run (`schedules`, a run button) says the time on its verbs; any other is told the
// allowance is spent in the line above and left to choose.
const booked = computed(() => (request.value?.schedules === true ? spent.value : undefined));
const verb = (action: string): string => (booked.value === undefined ? action : t(`chat.hostPickerBody.atTime`, { action, when: booked.value.short }));
const verbIcon = (icon: IconName): IconName => (booked.value === undefined ? icon : `clock`);

/* WHAT THE PRESS COSTS, in the one line above it: the model, the tier it will think at where one is pinned, and when its allowance is back while it has none. */
const spend = computed<string>(() => {
    const held = request.value;
    if (held === undefined || !chosen.value) {
        return t(`chat.hostPickerBody.chooseModelToContinue`);
    }
    const tier = held.chooseRun === true ? effortLabelOf(held.effort, held.provider, held.model, held.thinking) : undefined;
    const reopens = spent.value;
    const back =
        reopens === undefined
            ? undefined
            : atReopenPhrase(
                  { at: (when) => t(`chat.hostPickerBody.spentAt`, { when }), in: (when) => t(`chat.hostPickerBody.spentIn`, { when }) },
                  reopens.reopensAt,
                  now.value,
              );
    return [modelLabelFor(held.provider, held.model), ...(tier === undefined ? [] : [tier]), ...(back === undefined ? [] : [back])].join(` · `);
});
// A booked press's tip says what pressing does instead of starting now.
const bookedNote = computed(() => (booked.value === undefined ? undefined : t(`chat.hostPickerBody.bookedNote`)));
const continueTip = computed((): Tip => ({ title: t(`chat.hostPickerBody.sameChat`), keys: submitKeys, note: bookedNote.value }));
const startOverTip = computed((): Tip =>
    request.value?.attempt?.continuable === true
        ? { title: t(`chat.hostPickerBody.freshChat`), note: bookedNote.value ?? t(`chat.hostPickerBody.cleanWorktree`) }
        : { title: t(`chat.hostPickerBody.freshChat`), keys: submitKeys, note: bookedNote.value ?? t(`chat.hostPickerBody.stopsAttempt`) },
);
const actionTip = computed((): Tip => ({ title: request.value?.action ?? ``, keys: submitKeys, note: bookedNote.value }));

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
                <!-- The composer picker's own three parts: the status line, the account rows, the toolbar under a rule. -->
                <PickerStatus :provider="request.provider" :harness="request.harness ?? `native`" :model="request.model" />
                <PickerAccounts
                    v-if="hasContent"
                    :provider="request.provider"
                    :harness="request.harness ?? `native`"
                    :model="request.model"
                    :account="request.account"
                    @select-account="stageModelPick({ account: $event })"
                />
                <div
                    v-if="runShown"
                    class="-mx-3 flex flex-col gap-2 px-3 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-line [&:not(:first-child)]:pt-2"
                >
                    <!-- A caller that does not carry run settings (`chooseRun`) gets the harness alone: a control whose answer is dropped is worse than none. -->
                    <PickerRunSettings
                        :provider="request.provider"
                        :model="request.model"
                        :harness="request.harness ?? `native`"
                        :effort="request.effort"
                        :thinking="request.thinking"
                        :fast="request.fast"
                        :settings="runSettings"
                        @update="stageModelPick($event)"
                        @select-harness="stageModelPick({ harness: $event })"
                    />
                </div>
            </div>
        </template>

        <!-- THE END OF THE PANEL, and the whole reason it now has one. -->
        <template #commit>
            <div class="sticky bottom-0 z-10 flex shrink-0 flex-col gap-1.5 border-t border-line bg-canvas px-3 py-2">
                <span class="truncate text-2xs" :class="chosen ? `text-subtle` : `text-muted`">{{ spend }}</span>
                <!-- OVER AN ATTEMPT, THE BAR IS ABOUT THE ATTEMPT (hostModelPicker.ts, AttemptOnOffer): the line names it and the verbs say what the press does to it. -->
                <template v-if="request.attempt">
                    <p class="truncate text-2xs text-muted" v-tooltip.top.overflow="request.attempt.summary">{{ request.attempt.summary }}</p>
                    <div class="flex gap-1.5">
                        <Button
                            tier="accent"
                            v-if="request.attempt.continuable"
                            :label="verb(t(`ui.action.continue`))"
                            class="flex-1"
                            :disabled="!chosen"
                            v-tooltip.top="continueTip"
                            @click="commitModelPick(`continue`)"
                        >
                            <template #icon><Icon :name="verbIcon(`play`)" /></template>
                        </Button>
                        <Button
                            :label="verb(t(`ui.action.startOver`))"
                            class="flex-1"
                            :tier="request.attempt.continuable ? `boring` : `accent`"
                            :disabled="!chosen"
                            v-tooltip.top="startOverTip"
                            @click="commitModelPick(`start-over`)"
                        >
                            <template #icon><Icon :name="verbIcon(`refresh`)" /></template>
                        </Button>
                    </div>
                </template>
                <!-- A spent allowance's press is a booking: the verb carries the time it starts, as the run button does. -->
                <Button
                    tier="accent"
                    v-else
                    :label="verb(request.action)"
                    class="w-full"
                    :disabled="!chosen"
                    v-tooltip.top="actionTip"
                    @click="commitModelPick()"
                >
                    <template #icon><Icon :name="verbIcon(`play`)" /></template>
                </Button>
            </div>
        </template>
    </ModelPicker>
</template>
