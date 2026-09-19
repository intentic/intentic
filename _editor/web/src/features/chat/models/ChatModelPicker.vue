<script setup lang="ts">
import { computed } from "vue";
import { limitationsOf } from "@intentic/sandbox-contract";
import { InfoHint } from "@intentic/ui";
import type { Conversation } from "../session/conversation";
import { AUTO_KEY, autoEntry, type PickerEntry } from "./modelPickerState";
import { usePickerAccounts } from "../accounts/pickerAccounts";
import { type RunSettingsPatch, usePickerRunSettings } from "./run-settings/pickerRunSettings";
import ModelPicker from "./ModelPicker.vue";
import PickerAccounts from "../accounts/PickerAccounts.vue";
import PickerRunSettings from "./run-settings/PickerRunSettings.vue";
import { useT } from "@intentic/ui/i18n";

// Chat's binding of the shared model picker: the list, the who-serves-the-turn block, and per-conversation footer
// controls (extended thinking, fast speed, this runtime's limits). Edits the given conversation, not the active tab, so
// a proposed session's picker can be re-pointed before it starts. Harness is a separate axis from the model.

const t = useT();

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

// Destructured once; every host remounts this component (v-if) rather than swapping the prop in place.
const { provider, harness, model, thinking, fast, effort, fastMode, streaming, generating, account, capabilities, box, auto, messages } = conversation;

// Gated by no setting: which model a chat runs on is a per-chat question, and a mode that only appears once you have
// found a switch on a settings page is a mode nobody finds. Which model does the reading IS a setting (the
// `model-router` job under Models), and that is the only part a sandbox configures.
// Offered exactly where the reading can happen, which is modelRoute.ts's own rule: a chat of this sandbox's with
// nothing sent yet. A chat already under way has a model, and it is running — an Auto row there would disarm itself at
// the next send, which is a control that lies.
const autoOffered = computed(() => messages.value.length === 0 && box.value === undefined);
const leadRows = computed(() =>
    autoOffered.value ? [autoEntry(t(`chat.chatModelPicker.autoLabel`), t(`chat.chatModelPicker.autoDescription`))] : [],
);
const leadSelected = computed(() => (auto.value ? AUTO_KEY : undefined));

// Whether the shared block has content for this provider; needed before the footer renders its own padding.
const { hasContent } = usePickerAccounts(provider, harness, model);

/* THE TWO CHIPS ARE THE SHARED CONTROL (PickerRunSettings): the same questions about the same model. */
const { hasContent: runSettingsShown } = usePickerRunSettings(provider, model, harness, thinking, effort, false);

// One patch per press, straight through to the conversation: settings of the next turn, so the panel stays
// open. Effort cannot arrive while the meter row is off, and is bound anyway so the two can never disagree.
const applyRun = (patch: RunSettingsPatch): void => {
    if (patch.effort !== undefined) {
        conversation.setEffort(patch.effort);
    }
    if (patch.thinking !== undefined) {
        conversation.setThinking(patch.thinking);
    }
    if (patch.fast !== undefined) {
        conversation.setFast(patch.fast);
    }
};

// Hidden, not inert: another box's account pays for nothing; the model list stays since it isn't box-scoped. Under
// Auto they are hidden for a second reason — the account is part of what the reading chooses, so offering one here
// would be a control over a decision not yet made.
const accountsShown = computed(() => hasContent.value && box.value === undefined && !auto.value);

// Mid-stream, only a same-provider model swap is allowed (a provider switch retires the session).
const unpickable = (entry: PickerEntry): boolean => streaming.value && entry.provider !== provider.value;

const pick = (entry: PickerEntry): void => {
    conversation.selectModel(entry);
    emit(`selected`);
};

// What the selected provider/harness pair can't do, from its declared record; empty for the ceiling (Claude Code loop).
const limitations = computed(() => limitationsOf(capabilities.value));

// Sentence per reason the harness can give; an unrecognized one still shows the raw word verbatim.
const FAST_MODE_REASONS: Record<string, string> = {
    free: `Fast speed needs a paid plan.`,
    preference: `Fast speed is switched off in this account's Claude settings.`,
    extra_usage_disabled: `Fast speed needs extra usage enabled on this account.`,
    model_not_allowed: `This model doesn't offer fast speed.`,
    not_first_party: `Fast speed isn't available on a routed endpoint.`,
    disabled_by_env: `Fast speed is disabled by this sandbox's environment.`,
    sdk_opt_in_required: `The harness declined the fast-speed request.`,
    network_error: `Couldn't reach Anthropic to confirm fast speed.`,
    pending: `Still confirming fast speed.`,
};

// Shown only when the answer disagrees with the ask: cooldown, a refusal with reason, or served without asking.
const fastSpeedNotice = computed<string | undefined>(() => {
    const state = fastMode.value;
    if (state === undefined) {
        return undefined;
    }
    if (state.state === `cooldown`) {
        return `Fast speed is rate-limited right now: turns run at standard speed until it resets.`;
    }
    if (state.state === `on`) {
        return fast.value ? undefined : `Ran at fast speed, this account has fast mode switched on by default.`;
    }
    if (!fast.value) {
        return undefined;
    }
    return state.reason === undefined
        ? `The last turn ran at standard speed.`
        : (FAST_MODE_REASONS[state.reason] ?? `The last turn ran at standard speed (${state.reason}).`);
});

// Whether the footer earns its own border and padding; prevents a rule drawn above an otherwise-empty footer.
// Under Auto everything below the explanation describes the model the chat would fall back to, not the one it will
// run: drawing accounts, effort and this runtime's limits there would be answering questions about the wrong model.
const footerVisible = computed(() => (auto.value ? true : accountsShown.value || runSettingsShown.value || limitations.value.length > 0));
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

                <!-- Account list and harness axis, shared with the shell's own picker. -->
                <PickerAccounts
                    v-if="accountsShown"
                    :provider="provider"
                    :harness="harness"
                    :model="model"
                    :account="account"
                    :accounts-locked="generating"
                    :harness-locked="streaming"
                    @select-account="conversation.selectAccount($event)"
                    @select-harness="conversation.selectHarness($event)"
                    @navigate="emit(`selected`)"
                />

                <!-- Extended thinking and speed: the shell picker's and the settings page's own chips, shared verbatim (PickerRunSettings). -->
                <div v-if="runSettingsShown && !auto" class="flex flex-col gap-1">
                    <PickerRunSettings
                        :provider="provider"
                        :model="model"
                        :harness="harness"
                        :effort="effort"
                        :thinking="thinking"
                        :fast="fast"
                        :effort-row="false"
                        @update="applyRun($event)"
                    />
                    <!-- Shown only when the harness's answer differs from the ask; a notice under a working control trains people to ignore notices. -->
                    <span v-if="fastSpeedNotice !== undefined" class="text-2xs text-subtle">{{ fastSpeedNotice }}</span>
                </div>

                <!-- One row (label-left/control-right), the list itself behind a hover card. -->
                <div v-if="limitations.length > 0 && !auto" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`chat.chatModelPicker.notAvailableHere`) }}</span>
                    <InfoHint :label="t(`chat.chatModelPicker.whatIsntAvailableHere`)" :text="`${limitations.length}`" class="shrink-0">
                        <!-- States its own heading, since the card teleports to the tooltip tier and may land clear of the row that raised it. -->
                        <span class="block text-xs font-medium text-content">{{ t(`chat.chatModelPicker.notAvailableHere`) }}</span>
                        <ul class="mt-1 flex flex-col gap-1 text-xs">
                            <li v-for="limit in limitations" :key="limit" class="flex items-start gap-1.5">
                                <span class="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden="true"></span>
                                <span class="text-muted">{{ limit }}</span>
                            </li>
                        </ul>
                    </InfoHint>
                </div>
            </div>
        </template>
    </ModelPicker>
</template>
