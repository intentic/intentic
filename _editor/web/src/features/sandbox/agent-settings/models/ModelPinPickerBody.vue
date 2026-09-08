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
import { usePickerRunSettings } from "../../../chat/models/pickerRunSettings";
import { useChat } from "../../../chat/run/useChat";

/* THE SETTINGS PAGE'S BINDING OF THE APP'S MODEL PICKER: the same panel the composer opens (ModelPicker, with
 * its search, its provider rail and every provider's catalog), pointed at one entry of one of the pinned lists
 * in Sandbox ▸ Agent ▸ Models.
 *
 * IT IS THE WHOLE PICKER BECAUSE THE OLD ONE WAS NOT. These rows used to offer a 14rem dropdown of
 * `${provider}:${model}` options: no search across a Claude catalog that is now dozens of rows long, no access
 * badge saying what an unconnected provider would cost, no custom-id escape hatch, and no sign that a model is
 * the one the chat itself is on. Every one of those already exists, once, in the panel the composer opens, and a
 * settings page that spends the sandbox's money deserves the same list rather than a lesser copy of it.
 *
 * NO ACCOUNTS, and that is the one deliberate difference from the composer's footer. An account id is a key in
 * this daemon's credential store and choosing between them is a question about the NEXT turn, answered where
 * that turn is (PickerAccounts, bound to a conversation). A standing pin naming one would go stale the first
 * time an account was dropped, and would tie these runs to a login the owner cannot see from the row. Which
 * account pays is left to the daemon, which spreads unattended work over whatever has headroom.
 *
 * EVERYTHING ELSE THE COMPOSER CONFIGURES IS HERE, per entry, which is the point of the rewrite: the reasoning
 * effort used to be ONE control beside the list, so a frontier head and the cheap account under it that catches
 * it were pinned to the same tier — and a tier scale is a property of the model, so any answer was off-scale for
 * half the list. Effort, extended thinking, speed and the harness now belong to the entry that will actually
 * run, and turn-resume.ts composes the turn from exactly these.
 *
 * A KNOB IS DRAWN ONLY WHERE IT WOULD BE HONOURED, and that is now nearly everywhere. The one-shot jobs used to
 * get the list and no footer, on the argument that the daemon runs them with thinking disabled and no effort —
 * which was true of the machinery and had become the reason for itself: an owner who pinned a reasoning model to
 * their commit subjects paid its price and was handed a cheaper model's behaviour. The one-shot path carries the
 * knobs now (claude/claude-one-shot.ts), so those rows draw them too.
 *
 * The cheaper-tier list is the remaining exception, and it is a real one: automatic tier selection substitutes a
 * model on a turn that already has its own effort and never touches an unattended run, so a control there would
 * be a switch with nothing behind it. */

const emit = defineEmits<{ pick: [ModelPin]; configure: [ModelPin]; close: [] }>();
const {
    pin,
    knobs = false,
    taken = [],
} = defineProps<{
    // The entry being re-pointed, or undefined while ADDING one. Adding draws no footer: there is nothing to
    // configure until the entry exists, and the row it lands on opens this same panel with the knobs in it.
    pin?: ModelPin | undefined;
    // Whether this list's entries carry their own run settings. See the header.
    knobs?: boolean;
    // `${provider}:${model}` of every entry already in the list. Offered but unpickable, the same treatment the
    // old dropdown gave them: a model that vanishes from a list as you use it makes you hunt for a row that was
    // there a moment ago.
    taken?: readonly string[];
}>();

/* WHAT THE LIST OPENS ON while adding: the model the owner's own chat is set to. The pair is what ModelPicker
 * checkmarks and which lane it hoists first, so anchoring it anywhere else would open a settings row on a
 * provider nobody is working in. */
const chat = useChat();
const provider = computed<AgentProvider>(() => pin?.provider ?? chat.provider.value);
const model = computed(() => pin?.model ?? chat.model.value);
const harness = computed<AgentHarness>(() => pin?.harness ?? `native`);

const capabilities = computed(() => capabilitiesOf(provider.value, harness.value));

/* THE THREE ROWS FOR HOW THIS ENTRY IS RUN — effort, extended thinking, speed — are the shell picker's own
 * (pickerRunSettings.ts), because they are the same rows asking the same questions about the same selection.
 * They were written out twice, here and in HostPickerBody, down to the clamp rule and the × beside the meter.
 * `hasContent` is what the footer below needs before it draws a border. */
const { hasContent: runSettingsShown } = usePickerRunSettings(
    provider,
    model,
    harness,
    computed(() => pin?.thinking),
    computed(() => pin?.effort),
);

// The harness axis, for the providers that have one: the same subscription model ids run under the provider's
// own loop or under Claude Code. Both chips NAME the runtime they select. WHICH providers those are is the
// contract's answer (a spec whose two harnesses name one runtime has nothing to choose), not a list kept here
// and in the chat picker separately — they had the same list twice, which is one edit away from disagreeing.
const harnessChoosable = computed(() => contractHarnessChoosable(provider.value));
const harnessOptions = computed(() => [
    { label: providerDisplayLabel(provider.value), value: `native` },
    { label: `Claude Code`, value: `claude-code` },
]);

// What this provider/harness pair cannot do, straight off its declared record: the honest half of a choice made
// for runs nobody is watching. Empty (the Claude Code loop, the ceiling) draws nothing.
const limitations = computed(() => limitationsOf(capabilities.value));

// Whether the footer earns the border and padding it draws: a rule over nothing is the one defect a footer like
// this has to make impossible.
const footerVisible = computed(
    () => knobs && pin !== undefined && (runSettingsShown.value || harnessChoosable.value || limitations.value.length > 0),
);

// A pin with the fields nobody set left OFF it rather than present-and-undefined: the daemon reads an absent
// field as "the provider's own default", and a stored `null` would be a third state nothing means.
const pruned = (next: ModelPin): ModelPin =>
    Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== ``)) as unknown as ModelPin;

const configure = (patch: Partial<ModelPin>): void => {
    if (pin !== undefined) {
        emit(`configure`, pruned({ ...pin, ...patch }));
    }
};

/* A MODEL ROW ANSWERS AND CLOSES, exactly as it does in the composer, because it is the question the panel was
 * opened with. The knob rows below write through and stay open: they are settings of the entry, not the answer.
 *
 * THE KNOBS SURVIVE A RE-POINT ONLY AS FAR AS THEY MEAN ANYTHING. Effort travels (every native scale has tiers,
 * and the clamp above shows what a shorter one will run at), while the harness, thinking and fast speed are
 * facts about the provider that vends the model: carrying them across a switch would pin a Codex entry to a
 * Claude-only knob. Same rule the shell's own picker follows for its account and harness pins. */
const pick = (entry: PickerEntry): void => {
    const kept = pin?.provider === entry.provider ? pin : { effort: pin?.effort };
    emit(`pick`, pruned({ ...kept, provider: entry.provider, model: entry.value }));
    emit(`close`);
};

// Every entry but the one being edited: re-picking the model an entry already holds has to stay possible, or
// opening a row and closing it again would look like the panel had lost its own selection.
const unpickable = (entry: PickerEntry): boolean =>
    `${entry.provider}:${entry.value}` !== `${pin?.provider}:${pin?.model}` && taken.includes(`${entry.provider}:${entry.value}`);
</script>

<template>
    <ModelPicker :provider="provider" :model="model" :unpickable="unpickable" @pick="pick" @close="emit(`close`)">
        <template #footer>
            <!-- The composer footer's own metrics (ModelPicker's 12px rhythm, on the canvas rather than the
                 panel), because a reader who opens this from a settings row and one who opens it from the
                 composer should not be able to tell which surface asked. -->
            <div
                v-if="footerVisible"
                class="scrollbar-thin flex min-h-0 shrink flex-col gap-2 overflow-y-auto border-t border-line bg-canvas px-3 py-2"
            >
                <!-- WHOSE SETTINGS THESE ARE. The list above browses every provider; everything here configures
                     the one entry, and unlabelled the two read as one screen. -->
                <div class="flex items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                        <ProviderLogo :provider="provider" class="shrink-0 text-xs" />
                        <span class="truncate">{{ providerDisplayLabel(provider) }} run</span>
                    </span>
                </div>

                <!-- Reasoning effort, extended thinking and speed: the shell picker's own rows, shared verbatim
                     (PickerRunSettings), because a reader configuring a pinned entry here and a run over there
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

                <!-- Harness axis (codex/grok): the provider's own runtime, or its model through the Claude Code
                     harness. Separate from the model, since the same subscription ids run under either. -->
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

                <!-- The honest half of the choice, and it matters more here than in the composer: nobody is
                     watching these runs, so "no mid-turn steering" is not something the user will discover by
                     trying it. One row, the count behind a hover card, exactly as the composer draws it. -->
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
