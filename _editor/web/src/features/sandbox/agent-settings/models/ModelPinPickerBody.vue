<script setup lang="ts">
import { computed } from "vue";
import {
    type AgentHarness,
    type AgentProvider,
    type ModelPin,
    capabilitiesOf,
    harnessChoosable as contractHarnessChoosable,
    limitationsOf,
} from "@intentic/sandbox-contract";
import { InfoHint } from "@intentic/ui";
import ModelPicker from "../../../chat/models/ModelPicker.vue";
import PickerRunSettings from "../../../chat/models/PickerRunSettings.vue";
import ProviderLogo from "../../../chat/accounts/ProviderLogo.vue";
import type { PickerEntry } from "../../../chat/models/modelPickerState";
import { providerDisplayLabel } from "../../../chat/accounts/providerCatalog";
import { defaultRunSettings, usePickerRunSettings } from "../../../chat/models/pickerRunSettings";
import { useChat } from "../../../chat/run/useChat";

// Full app model picker (composer's ModelPicker), pointed at one entry of a pinned list. No account control: that's a
// per-turn question (PickerAccounts); the daemon spreads unattended work over headroom instead. Effort, thinking, fast
// and harness live per entry, not shared, and draw only where the run would honour them.

const emit = defineEmits<{ pick: [ModelPin]; configure: [ModelPin]; close: [] }>();
const {
    pin,
    knobs = false,
    taken = [],
} = defineProps<{
    // Undefined while adding: nothing exists yet to configure until the entry's own row reopens this panel.
    pin?: ModelPin | undefined;
    // Whether this list's entries carry their own run settings.
    knobs?: boolean;
    // Already-taken entries stay visible but unpickable, so the list doesn't shift under you as you use it.
    taken?: readonly string[];
}>();

// The model the owner's own chat is set to, so the picker anchors on a provider actually in use.
const chat = useChat();
const provider = computed<AgentProvider>(() => pin?.provider ?? chat.provider.value);
const model = computed(() => pin?.model ?? chat.model.value);
const harness = computed<AgentHarness>(() => pin?.harness ?? `native`);

const capabilities = computed(() => capabilitiesOf(provider.value, harness.value));

/* THE THREE CONTROLS FOR HOW THIS ENTRY IS RUN — effort, extended thinking, speed — are the shell picker's own
 * (pickerRunSettings.ts), because they ask the same questions about the same kind of selection. They were
 * written out twice, here and in HostPickerBody, down to the clamp rule and the meter itself.
 * `hasContent` is what the footer below needs before it draws a border. */
const { hasContent: runSettingsShown } = usePickerRunSettings(
    provider,
    model,
    harness,
    computed(() => pin?.thinking),
    computed(() => pin?.effort),
);

// Which providers have a harness axis is the contract's answer, not a second list kept in sync by hand.
const harnessChoosable = computed(() => contractHarnessChoosable(provider.value));
const harnessOptions = computed(() => [
    { label: providerDisplayLabel(provider.value), value: `native` },
    { label: `Claude Code`, value: `claude-code` },
]);

// What this provider/harness pair cannot do, straight off its declared record: the honest half of a choice made
// for runs nobody is watching. Empty (the Claude Code loop, the ceiling) draws nothing.
const limitations = computed(() => limitationsOf(capabilities.value));

// Whether the footer earns its border and padding: never draw a rule over nothing.
const footerVisible = computed(
    () => knobs && pin !== undefined && (runSettingsShown.value || harnessChoosable.value || limitations.value.length > 0),
);

// Unset fields are dropped rather than stored as undefined, since the daemon reads an absent field as the provider's
// default and a stored null would be a third, meaningless state.
const pruned = (next: ModelPin): ModelPin =>
    Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== ``)) as unknown as ModelPin;

const configure = (patch: Partial<ModelPin>): void => {
    if (pin !== undefined) {
        emit(`configure`, pruned({ ...pin, ...patch }));
    }
};

/* A pick answers and closes, like the composer; the controls below write through and stay open as entry
 * settings. Effort survives a re-point; harness, thinking and fast speed don't, since they belong to the
 * provider, not the pin.
 *
 * A PIN IS BORN WITH ITS RUN SETTINGS ALREADY SET (`defaultRunSettings`), because the panel that configures it
 * has no way to say "leave it to the model" and a reader must never be shown a state the entry does not hold.
 * They go under the pick, so anything carried across the re-point still wins. */
const pick = (entry: PickerEntry): void => {
    const kept = pin?.provider === entry.provider ? pin : { effort: pin?.effort };
    emit(`pick`, pruned({ ...defaultRunSettings(), ...kept, provider: entry.provider, model: entry.value }));
    emit(`close`);
};

// Excludes the entry being edited: re-picking the model an entry already holds must stay possible.
const unpickable = (entry: PickerEntry): boolean =>
    `${entry.provider}:${entry.value}` !== `${pin?.provider}:${pin?.model}` && taken.includes(`${entry.provider}:${entry.value}`);
</script>

<template>
    <ModelPicker :provider="provider" :model="model" :unpickable="unpickable" @pick="pick" @close="emit(`close`)">
        <template #footer>
            <!-- Composer footer's own spacing, so a reader can't tell whether this opened from a settings row or the composer. -->
            <div
                v-if="footerVisible"
                class="scrollbar-thin flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2"
            >
                <!-- Labels whose settings these are: the picker above browses every provider, this configures only the one entry. -->
                <div class="flex items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                        <ProviderLogo :provider="provider" class="shrink-0 text-xs" />
                        <span class="truncate">{{ providerDisplayLabel(provider) }} run</span>
                    </span>
                </div>

                <!-- Reasoning effort, extended thinking and speed: the shell picker's own controls, shared
                     verbatim (PickerRunSettings), because a reader configuring a pinned entry here and a run over there
                     is answering the same three questions about the same kind of selection. -->
                <PickerRunSettings
                    :provider="provider"
                    :model="model"
                    :harness="harness"
                    :effort="pin?.effort"
                    :thinking="pin?.thinking"
                    :fast="pin?.fast"
                    @update="configure($event)"
                />

                <!--
                    Harness axis: the provider's own runtime, or its model through Claude Code. Separate from the model since the same subscription
                    ids run under either.
                -->
                <div v-if="harnessChoosable" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Harness</span>
                    <div class="flex items-center gap-1">
                        <button
                            v-for="option in harnessOptions"
                            :key="option.value"
                            type="button"
                            class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': harness === option.value }"
                            :aria-pressed="harness === option.value"
                            @click="configure({ harness: option.value as AgentHarness })"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                </div>

                <!--
                    Matters more here than in the composer: nobody is watching these runs, so a limitation like "no mid-turn steering" won't be
                    discovered by trying it.
                -->
                <div v-if="limitations.length > 0" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Not available here</span>
                    <InfoHint label="What isn't available here" :text="`${limitations.length}`" class="shrink-0">
                        <span class="block text-xs font-medium text-content">Not available here</span>
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
