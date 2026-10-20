<script setup lang="ts">
import { computed } from "vue";
import { modelLabelFor } from "../../../models/providers/providerCatalog";
import type { Conversation } from "../../../models/conversations/session/conversation";
import { AUTO_KEY, autoEntry, type PickerEntry } from "../../../models/conversations/accounts/modelPickerState";
import { usePickerAccounts } from "../accounts/pickerAccounts";
import { type RunSettingsPatch, usePickerRunSettings } from "../../../models/providers/pickerRunSettings";
import ModelPicker from "./ModelPicker.vue";
import PickerAccounts from "../accounts/PickerAccounts.vue";
import PickerRunSettings from "./run-settings/PickerRunSettings.vue";
import PickerStatus from "../accounts/PickerStatus.vue";
import { loopRowShown, offeredLoops } from "../../../models/providers/offeredLoops";
import { useT } from "@intentic/ui/i18n";

// Chat's binding of the shared model picker: the list, then a footer every picker draws in the same three parts: one status
// line (PickerStatus), the account rows (PickerAccounts) and one toolbar (PickerRunSettings). Edits the given conversation, not the active tab, so
// a proposed session's picker can be re-pointed before it starts. Harness is a separate axis from the model.

const t = useT();

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

// Destructured once; every host remounts this component (v-if) rather than swapping the prop in place.
const { provider, harness, model, thinking, fast, effort, account, accountNamed, auto } = conversation.selection;
const { fastMode, box, activeModel } = conversation;
const { streaming, generating } = conversation.turn;
const { messages, pendingPlanMessage } = conversation.transcript;
const { autoOpen } = conversation.selection;

// Gated by no setting: which model a chat runs on is a per-chat question, and a mode that only appears once you have
// found a switch on a settings page is a mode nobody finds. Which model does the reading IS a setting (the
// New chat routing job under Models), and that is the only part a sandbox configures.
// Offered exactly where the reading can happen, which is chatRoute.ts's own rule: a chat of this sandbox's with
// nothing sent yet. A chat already under way has a model, and it is running — an Auto row there would disarm itself at
// the next send, which is a control that lies. So would one on a chat whose first message is already booked or held:
// that message went to the sandbox with its model, and no reading reaches it (autoOpen).
const autoOffered = computed(() => messages.value.length === 0 && box.value === undefined && autoOpen.value);
const leadRows = computed(() => (autoOffered.value ? [autoEntry(t(`chat.words.autoLabel`), t(`chat.chatModelPicker.autoDescription`))] : []));
const leadSelected = computed(() => (auto.value ? AUTO_KEY : undefined));

// Whether the account rows draw for this provider, and a refusal no row carries; needed before the footer renders its own padding.
const { hasContent: listed, unplacedRefusal } = usePickerAccounts(provider, harness, model);

/* THE TWO CHIPS ARE THE SHARED CONTROL (PickerRunSettings): the same questions about the same model. */
const { hasContent: runSettingsShown } = usePickerRunSettings(provider, model, harness, thinking, effort, false);

// One patch per press, straight through to the conversation: settings of the next turn, so the panel stays
// open. Effort cannot arrive while the meter row is off, and is bound anyway so the two can never disagree.
const applyRun = (patch: RunSettingsPatch): void => {
    if (patch.effort !== undefined) {
        conversation.selection.apply({ kind: `setEffort`, effort: patch.effort });
    }
    if (patch.thinking !== undefined) {
        conversation.selection.apply({ kind: `setThinking`, thinking: patch.thinking });
    }
    if (patch.fast !== undefined) {
        conversation.selection.apply({ kind: `setFast`, fast: patch.fast });
    }
};

// Hidden, not inert: another box's account pays for nothing; the model list stays since it isn't box-scoped. Under
// Auto they are hidden for a second reason — the account is part of what the reading chooses, so offering one here
// would be a control over a decision not yet made.
const accountsHere = computed(() => box.value === undefined && !auto.value);
const accountsShown = computed(() => listed.value && accountsHere.value);

// Mid-stream, only a same-provider model swap is allowed (a provider switch retires the session). Refused with its reason,
// said where the row's description would be: a greyed provider with no reason read as one that was not connected.
const unpickable = (entry: PickerEntry): string | false =>
    streaming.value && entry.provider !== provider.value ? t(`chat.chatModelPicker.otherProviderAfterTurn`) : false;

// A pick made while a turn is live is for the next one: the sandbox has no way to move a running turn to another model,
// and a turn parked on a card (a plan's Approve included) carries on where it is. Said before the press, since nothing
// on screen changes after it: the logo is the same for every model of a provider. Named by what this window sent the
// turn on, else what the turn reported.
const liveTurnNote = computed<string | undefined>(() => {
    if (!streaming.value) {
        return undefined;
    }
    const running = conversation.selection.state.value.sentModel ?? activeModel.value ?? undefined;
    const label = running === undefined || running === `` ? undefined : modelLabelFor(provider.value, running);
    if (pendingPlanMessage.value !== undefined) {
        return label === undefined ? t(`chat.chatModelPicker.planKeepsItsModel`) : t(`chat.chatModelPicker.planKeepsModel`, { model: label });
    }
    return label === undefined ? t(`chat.chatModelPicker.turnKeepsItsModel`) : t(`chat.chatModelPicker.turnKeepsModel`, { model: label });
});

const pick = (entry: PickerEntry): void => {
    conversation.selection.apply({ kind: `selectModel`, pick: entry });
    emit(`selected`);
};

// The harness row: a choice where the account block is this chat's to set, and where it is not (another box's session),
// still the loop's name with what it can't do and what its vendor says, since those decide whether to send at all.
const loopChoosable = computed(() => box.value === undefined);
const runShown = computed(
    () => !auto.value && (runSettingsShown.value || loopRowShown(provider.value, offeredLoops(provider.value), harness.value, loopChoosable.value)),
);

// Sentence per reason the harness can give; an unrecognized one still shows the raw word verbatim.
// Built when read, so a switched language reaches it.
const fastModeReasons = (): Record<string, string> => ({
    free: t(`chat.chatModelPicker.fastNeedsPaidPlan`),
    preference: t(`chat.chatModelPicker.fastSwitchedOff`),
    extra_usage_disabled: t(`chat.chatModelPicker.fastNeedsExtraUsage`),
    model_not_allowed: t(`chat.chatModelPicker.fastModelNotAllowed`),
    not_first_party: t(`chat.chatModelPicker.fastNotFirstParty`),
    disabled_by_env: t(`chat.chatModelPicker.fastDisabledByEnv`),
    sdk_opt_in_required: t(`chat.chatModelPicker.fastHarnessDeclined`),
    network_error: t(`chat.chatModelPicker.fastNetworkError`),
    pending: t(`chat.chatModelPicker.fastPending`),
});

// Shown only when the answer disagrees with the ask: cooldown, a refusal with reason, or served without asking.
const fastSpeedNotice = computed<string | undefined>(() => {
    const state = fastMode.value;
    if (state === undefined) {
        return undefined;
    }
    if (state.state === `cooldown`) {
        return t(`chat.chatModelPicker.fastCooldown`);
    }
    if (state.state === `on`) {
        return fast.value ? undefined : t(`chat.chatModelPicker.fastByDefault`);
    }
    if (!fast.value) {
        return undefined;
    }
    return state.reason === undefined
        ? t(`chat.chatModelPicker.ranStandard`)
        : (fastModeReasons()[state.reason] ?? t(`chat.chatModelPicker.ranStandardBecause`, { reason: state.reason }));
});

// Whether the footer earns its own border and padding; prevents a rule drawn above an otherwise-empty footer.
// Under Auto everything below the explanation describes the model the chat would fall back to, not the one it will
// run: drawing accounts, effort and this runtime's limits there would be answering questions about the wrong model.
const footerVisible = computed(() =>
    auto.value || liveTurnNote.value !== undefined
        ? true
        : accountsShown.value || (accountsHere.value && unplacedRefusal.value !== undefined) || runShown.value,
);
</script>

<template>
    <ModelPicker
        :provider="provider"
        :model="model"
        :unpickable="unpickable"
        :lead-rows="leadRows"
        :lead-selected="leadSelected"
        @pick="pick"
        @close="emit(`selected`)"
    >
        <template #footer>
            <!-- Session controls with no place in the shared list: who serves the turn, extended thinking, fast speed, and this runtime's limits. -->
            <!-- Matches the model list's own px-3 rhythm; row groups counter it with -mx-3 so their tint still spans the panel. -->
            <!-- Shrinks and scrolls instead of holding natural height, paired with the list's own floor. -->
            <!-- bg-canvas marks the footer as the surface the list stands on, not more list; a rule alone read unclearly on a tall picker. -->
            <div v-if="footerVisible" class="flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2">
                <!-- What Auto is about to do, said where it was switched on: a mode that changes the model owes an explanation before it does, not after. -->
                <div v-if="auto" class="flex flex-col gap-1">
                    <span class="text-2xs text-subtle">{{ t(`chat.chatModelPicker.autoArmed`) }}</span>
                    <!-- The one part of Auto a sandbox configures: which model does the reading. -->
                    <RouterLink to="/sandbox/agent#models" class="text-2xs text-link hover:underline" @click="emit(`selected`)">
                        {{ t(`chat.chatModelPicker.chooseWhichModelReads`) }}
                    </RouterLink>
                </div>

                <!-- THE STATUS LINE: every message this footer has, in one line: a live turn (whose model it finishes on), a refusal no row
                     carries, how fresh the meters are. Never a paragraph above or below the rows. -->
                <PickerStatus v-if="!auto" :provider="provider" :harness="harness" :model="model" :note="liveTurnNote" :accounts="accountsHere" />

                <!-- THE ROWS: who pays, shared with the shell's own picker. Ticks the account the next turn runs on, as the selection's servingAccount does. -->
                <PickerAccounts
                    v-if="accountsShown"
                    :provider="provider"
                    :harness="harness"
                    :model="model"
                    :account="account"
                    :named="accountNamed"
                    :accounts-locked="generating"
                    @select-account="conversation.selection.apply({ kind: `selectAccount`, account: $event })"
                />

                <!-- THE TOOLBAR: how it runs, under one rule spanning the panel whenever anything stands above it. The harness locks
                     once a turn streams, since switching it retires the session the turn runs in. -->
                <div
                    v-if="runShown"
                    class="-mx-3 flex flex-col gap-2 px-3 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-line [&:not(:first-child)]:pt-2"
                >
                    <PickerRunSettings
                        :provider="provider"
                        :model="model"
                        :harness="harness"
                        :effort="effort"
                        :thinking="thinking"
                        :fast="fast"
                        :effort-row="false"
                        :loop-choosable="loopChoosable"
                        :loop-locked="streaming"
                        :fast-notice="fastSpeedNotice"
                        @update="applyRun($event)"
                        @select-harness="conversation.selection.apply({ kind: `selectHarness`, harness: $event })"
                    />
                </div>
            </div>
        </template>
    </ModelPicker>
</template>
