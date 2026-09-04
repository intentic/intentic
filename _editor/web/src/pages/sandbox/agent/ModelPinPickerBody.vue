<script setup lang="ts">
import { computed } from "vue";
import {
    type AgentHarness,
    type AgentProvider,
    type AgentRunPin,
    capabilitiesOf,
    fastAllowed,
    harnessChoosable as contractHarnessChoosable,
    limitationsOf,
} from "@intentic/sandbox-contract";
import { InfoHint, SegmentedControl, ui } from "@intentic/ui";
import EffortMeter from "../../../chat/EffortMeter.vue";
import ModelPicker from "../../../chat/ModelPicker.vue";
import ProviderLogo from "../../../chat/ProviderLogo.vue";
import { clampEffort, effortsFor } from "../../../composables/chat/effortScale";
import type { PickerEntry } from "../../../composables/chat/modelPicker";
import { providerDisplayLabel, providerModels } from "../../../composables/chat/providerCatalog";
import { useChat } from "../../../composables/chat/useChat";

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
 * A KNOB IS DRAWN ONLY WHERE IT WOULD BE HONOURED. The quick-model and cheaper-tier lists get the list and no
 * footer at all: their jobs are one-shot calls the daemon deliberately runs with thinking disabled and no
 * effort (agent/one-shot.ts), and automatic tier selection never touches an unattended run, so a control there
 * would be a switch with nothing behind it. */

const emit = defineEmits<{ pick: [AgentRunPin]; configure: [AgentRunPin]; close: [] }>();
const {
    pin,
    knobs = false,
    taken = [],
} = defineProps<{
    // The entry being re-pointed, or undefined while ADDING one. Adding draws no footer: there is nothing to
    // configure until the entry exists, and the row it lands on opens this same panel with the knobs in it.
    pin?: AgentRunPin | undefined;
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

/* THINKING HAS THREE STATES HERE and the scale is read against all three, not two. Claude's API refuses 'max'
 * with thinking DISABLED, so an entry whose thinking chip says Off loses the rung; an entry that pinned nothing
 * keeps it, because the turn then goes out with no thinking field and the daemon names the reasoning that tier
 * needs on the way (sendableThinking). Collapsing absent onto off, which this used to do, hid the top tier
 * behind a chip nobody had touched. */
const thinkingPin = computed(() => pin?.thinking);
const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinkingPin.value) : []));

/* CLAMPED FOR DISPLAY, never written back, the composer's own rule (effortScale.ts). Switching thinking off, or
 * re-pointing the entry at a model with a shorter scale, would otherwise leave a stored 'max' lighting no rung
 * at all and reading as an unset control. The user's own pick stays stored for the day the longer scale is back. */
const effort = computed(() =>
    pin?.effort === undefined || pin.effort === `` ? `` : clampEffort(pin.effort, provider.value, model.value, thinkingPin.value),
);

// Fast speed exists only where the runtime, the route AND the model's own catalog row allow it, so the control
// appears and disappears with the model instead of sitting greyed under an explanation nobody reads.
const fastOffered = computed(() =>
    fastAllowed(
        capabilities.value,
        provider.value,
        (providerModels.value[provider.value] ?? []).find((option) => option.value === model.value)?.badges,
    ),
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

// Three stops rather than a toggle, because absent is not the same as off: a pin that says nothing about
// thinking sends nothing, and the harness's own default (Claude reasons) answers. A two-state chip would draw
// that as "off" and be wrong about what the run does.
const THINKING_OPTIONS = [
    { label: `Default`, value: `` },
    { label: `On`, value: `on` },
    { label: `Off`, value: `off` },
];
// Speed IS binary: an absent `fast` means standard speed, which is what the turn schema says it means.
const SPEED_OPTIONS = [
    { label: `Standard`, value: `standard` },
    { label: `Fast`, value: `fast` },
];

// What this provider/harness pair cannot do, straight off its declared record: the honest half of a choice made
// for runs nobody is watching. Empty (the Claude Code loop, the ceiling) draws nothing.
const limitations = computed(() => limitationsOf(capabilities.value));

// Whether the footer earns the border and padding it draws: a rule over nothing is the one defect a footer like
// this has to make impossible.
const footerVisible = computed(
    () =>
        knobs &&
        pin !== undefined &&
        (efforts.value.length > 0 || provider.value === `claude` || harnessChoosable.value || limitations.value.length > 0),
);

// A pin with the fields nobody set left OFF it rather than present-and-undefined: the daemon reads an absent
// field as "the provider's own default", and a stored `null` would be a third state nothing means.
const pruned = (next: AgentRunPin): AgentRunPin =>
    Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== ``)) as unknown as AgentRunPin;

const configure = (patch: Partial<AgentRunPin>): void => {
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

                <!-- REASONING EFFORT: the app's own meter (EffortMeter), the control the composer draws beside
                     its model pill. "Default" is a real state and not decoration: an unpinned effort means the
                     turn goes out without one and the model's own answers, so that word sits where the level
                     would be until a rung is chosen.
                     THE WAY BACK IS AN ×, NOT THE WORD AGAIN. It read "Max Default" side by side on screen —
                     two words in the same size where one is the state and the other is a control, which is one
                     phrase to anybody scanning the row. The × is the same gesture the list rows use to take an
                     entry out, one level down: this takes the tier out and leaves the model. -->
                <div v-if="efforts.length > 0" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Reasoning effort</span>
                    <span class="flex shrink-0 items-center gap-1.5">
                        <EffortMeter :efforts="efforts" :effort="effort" empty-label="Default" @pick="configure({ effort: $event })" />
                        <button
                            v-if="effort !== ``"
                            type="button"
                            :class="ui.iconButton(`h-auto w-auto shrink-0 rounded p-1 text-subtle`)"
                            v-tooltip.top="`Take this model's own default effort`"
                            aria-label="Take this model's own default effort"
                            @click="configure({ effort: undefined })"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </span>
                </div>

                <!-- CLAUDE'S TWO KNOBS. Thinking is three-stop for the reason THINKING_OPTIONS gives; speed is
                     binary, and offered only where the runtime, the route and the model all allow it. -->
                <div v-if="provider === `claude`" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Extended thinking</span>
                    <SegmentedControl
                        :model-value="pin?.thinking === undefined ? `` : pin.thinking ? `on` : `off`"
                        :options="THINKING_OPTIONS"
                        wrap
                        @update:model-value="(value: string) => configure({ thinking: value === `` ? undefined : value === `on` })"
                    />
                </div>
                <div v-if="fastOffered" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Speed</span>
                    <SegmentedControl
                        :model-value="pin?.fast === true ? `fast` : `standard`"
                        :options="SPEED_OPTIONS"
                        wrap
                        @update:model-value="(value: string) => configure({ fast: value === `fast` ? true : undefined })"
                    />
                </div>

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
