<script setup lang="ts">
import { computed } from "vue";
import { limitationsOf } from "@intentic/sandbox-contract";
import { InfoHint } from "@intentic/ui";
import type { Conversation } from "../session/conversation";
import { AUTO_KEY, autoEntry, type PickerEntry } from "./modelPickerState";
import { usePickerAccounts } from "../accounts/pickerAccounts";
import { modelLabelFor } from "../accounts/providerCatalog";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
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
const { provider, harness, model, thinking, fast, effort, fastMode, tierHold, tierAnswer, streaming, generating, account, capabilities, box, auto } =
    conversation;

// Sandbox-wide automatic-tier mode; decides what the tier block may show (a dead control is worse than none).
const { settings } = useSandboxSettings();
const tierMode = computed(() => settings.value?.autoTier ?? `shadow`);

// Auto is offered only in the mode that has somewhere to send the reading; everywhere else the row would be a control
// that does nothing, which is worse than no row.
const leadRows = computed(() =>
    tierMode.value === `judge` ? [autoEntry(t(`chat.chatModelPicker.autoLabel`), t(`chat.chatModelPicker.autoDescription`))] : [],
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

// Hidden, not inert: another box's account pays for nothing; the model list stays since it isn't box-scoped.
const accountsShown = computed(() => hasContent.value && box.value === undefined);

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

// Worth a row only in `on` mode; in Measure nothing is substituted, so the veto describes a non-event.
const tierHoldOffered = computed(() => tierMode.value === `on`);

// Shown only when the judge disagrees with the plain pick: a substitution, a veto, or measure's would-have.
const tierNotice = computed<string | undefined>(() => {
    const answer = tierAnswer.value;
    if (answer === undefined || answer.tier !== `fast`) {
        return undefined;
    }
    if (answer.routed && answer.model !== undefined) {
        return `The last turn looked simple, so it ran on ${modelLabelFor(provider.value, answer.model)}.`;
    }
    if (answer.held === true) {
        return `The last turn looked simple; your hold kept it on your pick.`;
    }
    if (tierMode.value === `shadow`) {
        return `The last turn looked simple. Measuring: it still ran on your pick.`;
    }
    return undefined;
});

// Whether the footer earns its own border and padding; prevents a rule drawn above an otherwise-empty footer.
const footerVisible = computed(
    () =>
        accountsShown.value ||
        runSettingsShown.value ||
        limitations.value.length > 0 ||
        tierHoldOffered.value ||
        tierNotice.value !== undefined ||
        auto.value,
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
                <span v-if="auto" class="text-2xs text-subtle">{{ t(`chat.chatModelPicker.autoArmed`) }}</span>

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
                <div v-if="runSettingsShown" class="flex flex-col gap-1">
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

                <!-- The toggle is the standing veto (tierHold), shown only where it could stop something. -->
                <div v-if="tierHoldOffered || tierNotice !== undefined" class="flex flex-col gap-1">
                    <div v-if="tierHoldOffered" class="flex items-center justify-between gap-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t(`chat.chatModelPicker.simpleTurnsMayRun`) }}</span>
                        <button
                            type="button"
                            class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': tierHold }"
                            @click="conversation.setTierHold(!tierHold)"
                            :aria-pressed="tierHold"
                            :aria-label="t(`chat.chatModelPicker.keepConversationOnPicked`)"
                        >
                            <Icon name="credit-card" class="text-2xs" />
                            <span>{{ tierHold ? t(`chat.chatModelPicker.myPickOnly`) : t(`chat.chatModelPicker.allowed`) }}</span>
                        </button>
                    </div>
                    <span v-if="tierNotice !== undefined" class="text-2xs text-subtle">{{ tierNotice }}</span>
                    <RouterLink
                        v-if="tierHoldOffered"
                        to="/sandbox/agent#models"
                        class="text-2xs text-link hover:underline"
                        @click="emit(`selected`)"
                    >
                        {{ t(`chat.chatModelPicker.turnOffEveryChat`) }}
                    </RouterLink>
                </div>

                <!-- One row (label-left/control-right), the list itself behind a hover card. -->
                <div v-if="limitations.length > 0" class="flex items-center justify-between gap-2">
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
