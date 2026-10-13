<script setup lang="ts">
import { computed } from "vue";
import { type AgentHarness, type AgentProvider, type ModelPin, termsOf } from "@intentic/sandbox-contract";
import ModelPicker from "../../../chat/models/ModelPicker.vue";
import PickerRunSettings from "../../../chat/models/run-settings/PickerRunSettings.vue";
import ProviderLogo from "../../../chat/accounts/ProviderLogo.vue";
import LoopTermsRow from "../../../chat/models/LoopTermsRow.vue";
import LoopChips from "../../../chat/models/LoopChips.vue";
import LoopLimitsRow from "../../../chat/models/LoopLimitsRow.vue";
import { limitationsOn, offeredLoops, selectedLoop } from "../../../chat/models/offeredLoops";
import type { PickerEntry } from "../../../chat/models/modelPickerState";
import { providerDisplayLabel } from "../../../chat/accounts/providerCatalog";
import { carryPinKnobs, defaultPinRunSettings, honoredPinKnobs, usePickerRunSettings } from "../../../chat/models/run-settings/pickerRunSettings";
import { useChat } from "../../../chat/run/useChat";
import { useT } from "@intentic/ui/i18n";

// Full app model picker (composer's ModelPicker), pointed at one entry of a pinned list. No account control: that's a
// per-turn question (PickerAccounts); the daemon spreads unattended work over headroom instead. Effort, thinking, fast
// and harness live per entry, not shared, and draw only where the run would honour them.

const t = useT();

const emit = defineEmits<{ pick: [ModelPin]; configure: [ModelPin]; close: [] }>();
const {
    pin,
    current,
    knobs = false,
    taken = [],
    helperJobs = false,
} = defineProps<{
    // Undefined while adding: nothing exists yet to configure until the entry's own row reopens this panel.
    pin?: ModelPin | undefined;
    // While adding: the model the job itself runs on first, the one the list ticks. Undefined for a job with none.
    current?: ModelPin | undefined;
    // Whether this list's entries carry their own run settings.
    knobs?: boolean;
    // Already-taken entries stay visible but unpickable, so the list doesn't shift under you as you use it.
    taken?: readonly string[];
    // Whether the list feeds one-shot helper jobs only (commit messages, titles): the one place a model that cannot run
    // a turn may be picked. A run job or a persona is a turn.
    helperJobs?: boolean;
}>();

// What the list ticks is the job's own model, never the chat's: ticking the chat's model on a job that does not run it
// read as that job's current model, and it was picked as one. A job with no model ticks nothing, and the chat's
// provider only decides which lane the list opens on.
const chat = useChat();
const shown = computed<ModelPin | undefined>(() => pin ?? current);
const provider = computed<AgentProvider>(() => shown.value?.provider ?? chat.provider.value);
const model = computed(() => shown.value?.model ?? ``);
const harness = computed<AgentHarness>(() => pin?.harness ?? `native`);

/* THE THREE CONTROLS FOR HOW THIS ENTRY IS RUN — effort, extended thinking, speed — are the shell picker's own (pickerRunSettings.ts). */
const { hasContent: runSettingsShown } = usePickerRunSettings(
    provider,
    model,
    harness,
    computed(() => pin?.thinking),
    computed(() => pin?.effort),
);

// Which loops this provider has is the daemon's answer (offeredLoops), not a second list kept in sync by hand.
const harnessChoosable = computed(() => offeredLoops(provider.value).length > 1);

// What this provider/harness pair cannot do, straight off its declared record: the honest half of a choice made
// for runs nobody is watching. Empty (the Claude Code loop, the ceiling) draws nothing.
const limitations = computed(() => limitationsOn(provider.value, offeredLoops(provider.value), harness.value));

// The vendor's own terms for this loop, beside its limits: a pin is a choice made for runs nobody is watching.
const terms = computed(() => termsOf(provider.value, selectedLoop(offeredLoops(provider.value), harness.value)));

// Whether the footer earns its border and padding: never draw a rule over nothing.
const footerVisible = computed(
    () => knobs && pin !== undefined && (runSettingsShown.value || harnessChoosable.value || limitations.value.length > 0 || terms.value !== undefined),
);

// Unset fields are dropped rather than stored as undefined, since the daemon reads an absent field as the provider's
// default and a stored null would be a third, meaningless state.
const pruned = (next: ModelPin): ModelPin =>
    Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== ``)) as unknown as ModelPin;

const configure = (patch: Partial<ModelPin>): void => {
    if (pin !== undefined) {
        emit(`configure`, honoredPinKnobs(pruned({ ...pin, ...patch })));
    }
};

/* A pick answers and closes, like the composer; the controls below write through and stay open as entry settings. */
const pick = (entry: PickerEntry): void => {
    const targetHarness = pin?.provider === entry.provider ? (pin.harness ?? `native`) : `native`;
    const next =
        pin?.provider === entry.provider && pin !== undefined
            ? { ...pin, model: entry.value }
            : {
                  ...defaultPinRunSettings(entry.provider, targetHarness),
                  ...carryPinKnobs(pin, entry.provider, targetHarness),
                  provider: entry.provider,
                  model: entry.value,
              };
    emit(`pick`, honoredPinKnobs(pruned(next)));
    emit(`close`);
};

// Excludes the entry being edited: re-picking the model an entry already holds must stay possible.
const unpickable = (entry: PickerEntry): boolean =>
    `${entry.provider}:${entry.value}` !== `${pin?.provider}:${pin?.model}` && taken.includes(`${entry.provider}:${entry.value}`);
</script>

<template>
    <ModelPicker
        :provider="provider"
        :model="model"
        :unpickable="unpickable"
        :helper-jobs="helperJobs"
        @pick="pick"
        @close="emit(`close`)"
    >
        <template #footer>
            <!-- Composer footer's own spacing, so a reader can't tell whether this opened from a settings row or the composer. -->
            <div v-if="footerVisible" class="flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2">
                <!-- Labels whose settings these are: the picker above browses every provider, this configures only the one entry. -->
                <div class="flex items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                        <ProviderLogo :provider="provider" class="shrink-0 text-xs" />
                        <span class="truncate">{{ t(`sandbox.modelPinPickerBody.run`, { provider: providerDisplayLabel(provider) }) }}</span>
                    </span>
                </div>

                <!-- Reasoning effort, extended thinking and speed: the shell picker's own controls, shared verbatim (PickerRunSettings). -->
                <PickerRunSettings
                    :provider="provider"
                    :model="model"
                    :harness="harness"
                    :effort="pin?.effort"
                    :thinking="pin?.thinking"
                    :fast="pin?.fast"
                    @update="configure($event)"
                />

                <!-- Loop axis: one chip per loop this sandbox's daemon runs the provider on. -->
                <LoopChips :provider="provider" :harness="harness" @select="configure({ harness: $event })" />

                <!-- Model limits must be visible before an unattended run starts. -->
                <LoopLimitsRow :provider="provider" :harness="harness" />

                <LoopTermsRow v-if="terms !== undefined" :terms="terms" />
            </div>
        </template>
    </ModelPicker>
</template>
