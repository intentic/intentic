<script setup lang="ts">
import type { BuiltinPromptText, SystemPromptMode } from "@intentic/sandbox-contract";
import { cmp, CopyButton, Row, RowGroup, Segmented } from "@intentic/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { sandboxJson } from "../../../composables/sandbox/sandboxClient";
import { useSavings } from "../../../composables/sandbox/useSavings";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { useAsyncAction } from "../../../composables/useAsyncAction";
import { asPercent, commitPercent } from "./percentInput";
import InstructionsInfo from "./InstructionsInfo.vue";

/* WHAT THE ASSISTANT IS TOLD, before the user types anything: how much it writes back, and which prompt it IS.
 * The two are one group because the second SUPERSEDES the first — a custom prompt drops the terse steer along
 * with everything else the daemon appends — and a setting that can silently switch off the setting above it
 * belongs next to it, saying so. */

const { settings, patch, save } = useSandboxSettings();
const { savings } = useSavings({});

/* --- System prompt -------------------------------------------------------------------------------------------
 * Three bases: Intentic's own (the default), Claude Code's, or one the owner writes. The first two are peers —
 * a base plus the harness wiring this app appends — and picking between them is a one-click preference. The
 * third replaces everything, which is why it is the only one that argues back.
 *
 * A prompt picker is a trap unless you can READ what each option is, so either built-in text is one click away
 * and either can be forked into a custom one. They are fetched ON DEMAND: Claude's costs a throwaway CLI turn
 * daemon-side (preset-prompt.ts) — cheap, but not something every visit to this tab should pay for.
 *
 * The draft is LOCAL rather than a computed over settings: saving is a whole-object POST that every other
 * control on this page renders from, and the text is a system prefix every live conversation is caching, so a
 * per-keystroke save would thrash both. It commits on blur (the textarea's own `change`) or from the Save
 * button, which is there because a save nobody can see is a save nobody trusts. */
const PROMPT_MAX = 20000; // SandboxSettingsSchema.systemPrompt's cap — the daemon rejects more.
const PROMPT_MODES: { label: string; value: SystemPromptMode }[] = [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
    { label: `Custom`, value: `custom` },
];
const promptMode = computed<SystemPromptMode>(() => settings.value?.systemPromptMode ?? `intentic`);
const prompt = ref(``);

/* The draft mirrors a SAVED value, and this remembers WHICH — the fix for a bug that reached the settings page:
 * seeding used to be guarded by "is the draft dirty?", and on first load an empty draft always differs from a
 * saved prompt, so the guard meant to protect an unsaved edit blocked the initial seed instead. The row then
 * showed mode Custom over an empty textarea with a live Save button — one click from silently wiping the
 * prompt. Comparing against the value the draft was seeded FROM tells the two states apart: not-yet-seeded is
 * `undefined`, an untouched draft still equals its seed, and anything else is the user's own typing. */
let seededFrom: string | undefined;
const promptDirty = computed(() => settings.value !== undefined && prompt.value !== settings.value.systemPrompt);
watch(
    () => settings.value?.systemPrompt,
    (saved) => {
        if (saved === undefined) {
            return;
        }
        // Seed on first load, and follow a change made in ANOTHER window — but never over an edit in this one.
        if (seededFrom === undefined || prompt.value === seededFrom) {
            prompt.value = saved;
        }
        seededFrom = saved;
    },
    { immediate: true },
);

const savePrompt = (): void => {
    // Normalise BEFORE the dirty check, not inside the payload: saving a trimmed copy of an untrimmed draft
    // leaves the two permanently unequal, and the row would sit there claiming unsaved changes forever.
    prompt.value = prompt.value.trim();
    if (promptDirty.value) {
        patch({ systemPrompt: prompt.value });
    }
};
// Switching base saves at once — it is a picker, not a draft. An unsaved custom edit is carried along rather
// than discarded: coming back to Custom finds the text still there, and it is only committed by Save.
const setPromptMode = (mode: string): void => patch({ systemPromptMode: mode as SystemPromptMode });

// The two built-in prompts, as text (GET /settings/system-prompt/{base}). Cached per base once fetched, so
// reopening the dialog is instant and forking doesn't re-fetch.
const builtinPrompts = ref<Partial<Record<string, BuiltinPromptText>>>({});
const viewingBase = ref<`intentic` | `claude` | undefined>(undefined);
const { busy: builtinBusy, error: builtinError, run: runBuiltin } = useAsyncAction();
const loadBuiltin = async (base: `intentic` | `claude`): Promise<BuiltinPromptText | undefined> => {
    if (builtinPrompts.value[base] === undefined) {
        await runBuiltin(async () => {
            builtinPrompts.value = { ...builtinPrompts.value, [base]: await sandboxJson<BuiltinPromptText>(`/settings/system-prompt/${base}`) };
        }, `Couldn't read that system prompt from your sandbox.`);
    }
    return builtinPrompts.value[base];
};
const viewBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    viewingBase.value = base;
    await loadBuiltin(base);
};
// Fork a built-in into the editor and switch to Custom. The TEXT is deliberately left unsaved: it is a starting
// point to edit, and saving it as-is would pin this sandbox to today's copy of a prompt it currently gets for
// free. The MODE is saved, because that is the click the user just made.
const forkBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    const fetched = await loadBuiltin(base);
    if (fetched !== undefined) {
        prompt.value = fetched.text;
        viewingBase.value = undefined;
        setPromptMode(`custom`);
    }
};

// The terse steer's measurement control, at turn level: the % of eligible turns that run WITHOUT it so the two
// arms can be compared.
const terseHoldoutPercent = computed<number>(() => asPercent(settings.value?.terseHoldout));
</script>

<template>
    <RowGroup label="Instructions">
        <template #info><InstructionsInfo /></template>

        <!-- Terse responses — steers the assistant to answer concisely (no restating context/tool output),
             cutting its own output tokens. A stable system-prompt suffix, so it doesn't hurt prompt-cache hits. -->
        <Row
            icon="align-left"
            title="Terse responses"
            description="Ask the assistant to answer concisely without restating context — fewer output tokens per reply."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.terseOutput ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ terseOutput: value })"
                />
            </template>
            <!-- The steer is one line appended to the system prompt, so a custom prompt takes it with
                 everything else. Said here rather than left to be discovered: a switch that is on and doing
                 nothing is worse than one that is off. -->
            <template #below>
                <p v-if="promptMode === `custom`" class="text-2xs text-warning">
                    Not applied while your own system prompt is set — say it in the prompt below instead.
                </p>
                <!-- The steer's measurement control. Unlike a cleaned command, which carries its own raw
                     baseline, a turn cannot be re-run to see what it would have said unsteered — so the only
                     way to know what this switch is worth is to leave a slice of turns unsteered and compare.
                     The control costs the very tokens it measures, which is why it is opt-in and says what it
                     buys. -->
                <template v-else-if="settings?.terseOutput === true">
                    <label class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-xs text-content">Measure it</span>
                            <span class="text-2xs text-muted">
                                Run this % of turns without the steer, as a control. Both arms need ~30 turns before a figure is reported.
                            </span>
                        </span>
                        <span class="flex shrink-0 items-center gap-1">
                            <input
                                type="number"
                                min="0"
                                max="100"
                                :value="terseHoldoutPercent"
                                :class="cmp.input('w-16 text-right text-xs')"
                                @change="
                                    (event: Event) => commitPercent(event, terseHoldoutPercent, (terseHoldout: number) => patch({ terseHoldout }))
                                "
                            />
                            <span class="text-xs text-muted">%</span>
                        </span>
                    </label>
                    <p v-if="savings?.output !== undefined" class="mt-2 border-t border-line pt-2 text-2xs">
                        <template v-if="savings.output.deltaPct !== undefined">
                            <span class="tabular-nums" :class="savings.output.deltaPct < 0 ? `text-success` : `text-muted`">
                                {{ savings.output.deltaPct < 0 ? `↓` : `↑` }}{{ Math.abs(savings.output.deltaPct) }}%
                            </span>
                            <span class="text-muted">
                                output tokens per turn ± {{ savings.output.marginPct }}pp, over {{ savings.output.on.turns }} steered vs
                                {{ savings.output.off.turns }} unsteered turns.
                            </span>
                        </template>
                        <span v-else class="text-muted">
                            Measuring — {{ savings.output.on.turns }} steered and {{ savings.output.off.turns }} unsteered turns so far, of
                            {{ savings.output.minTurns }} needed per arm.
                        </span>
                    </p>
                </template>
            </template>
        </Row>

        <!-- System prompt — which prompt the agent IS. Two built-in bases the app maintains, and an escape
             hatch that replaces them. It sits directly under Terse responses because Custom SUPERSEDES it:
             that mode drops the steer along with everything else, and the row above says so when it does.

             Every option can be read before it is chosen — a prompt picker whose options are three words
             each is a guess, not a choice — and either base can be forked into a starting point. -->
        <Row icon="pencil" title="System prompt">
            <template #description>
                <template v-if="promptMode === `custom`">Your own prompt — the agent runs on this text alone.</template>
                <template v-else-if="promptMode === `claude`">Claude Code's own prompt, as shipped in your sandbox's CLI.</template>
                <template v-else>Intentic's own prompt, tuned for this app.</template>
            </template>
            <template #control>
                <Segmented :model-value="promptMode" :options="PROMPT_MODES" @update:model-value="setPromptMode" />
            </template>
            <template #below>
                <!-- A base is read, not edited: the links are the whole surface. Forking is how you get from
                     "I like this but for one paragraph" to a custom prompt without retyping it. -->
                <template v-if="promptMode !== `custom`">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <button type="button" class="text-2xs font-medium text-link hover:underline" @click="viewBuiltin(promptMode)">
                            View this prompt
                        </button>
                        <button
                            type="button"
                            class="text-2xs font-medium text-link hover:underline disabled:opacity-50"
                            :disabled="builtinBusy"
                            @click="forkBuiltin(promptMode)"
                        >
                            Edit a copy of it
                        </button>
                        <button
                            type="button"
                            class="text-2xs font-medium text-muted hover:text-content hover:underline"
                            @click="viewBuiltin(promptMode === `intentic` ? `claude` : `intentic`)"
                        >
                            Compare with {{ promptMode === `intentic` ? `Claude's` : `Intentic's` }}
                        </button>
                    </div>
                </template>

                <template v-else>
                    <textarea
                        v-model="prompt"
                        rows="5"
                        :maxlength="PROMPT_MAX"
                        :disabled="settings === undefined"
                        placeholder="Write the assistant's system prompt, or start from one of the built-in prompts below."
                        :class="cmp.input('w-full resize-y font-mono text-xs')"
                        aria-label="System prompt"
                        @change="savePrompt"
                    ></textarea>

                    <!-- What Custom actually costs, shown while they are in it rather than discovered later
                         when the chat's cards quietly stop appearing. -->
                    <p :class="cmp.alertWarning('mt-1.5 text-2xs')">
                        Your text becomes the whole system prompt. Both built-in prompts are gone, and so is what this app tells the assistant about
                        itself — the question and plan cards, the checklist panel, and the browser tools it would otherwise know to reach for. Terse
                        responses stops applying too. Describe whatever you still want.
                    </p>

                    <div class="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                        <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <button
                                type="button"
                                class="text-2xs font-medium text-link hover:underline disabled:opacity-50"
                                :disabled="builtinBusy"
                                @click="forkBuiltin(`intentic`)"
                            >
                                Start from Intentic's
                            </button>
                            <button
                                type="button"
                                class="text-2xs font-medium text-link hover:underline disabled:opacity-50"
                                :disabled="builtinBusy"
                                @click="forkBuiltin(`claude`)"
                            >
                                Start from Claude's
                            </button>
                        </span>
                        <span class="flex shrink-0 items-center gap-2">
                            <span v-if="prompt.length > PROMPT_MAX - 1000" class="text-2xs text-muted">{{ prompt.length }} / {{ PROMPT_MAX }}</span>
                            <!-- Blur already saves; the button is for the user who can't tell that it did.
                                 `mousedown.prevent` keeps focus in the textarea, so pressing it doesn't blur-save
                                 the field and unmount the button out from under the click that was landing on it. -->
                            <Button
                                v-if="promptDirty"
                                label="Save"
                                size="small"
                                :loading="save.isPending.value"
                                @mousedown.prevent
                                @click="savePrompt"
                            />
                        </span>
                    </div>
                </template>
                <p v-if="builtinError !== undefined" :class="cmp.alertDanger('mt-1.5 text-2xs')">{{ builtinError }}</p>
            </template>
        </Row>
    </RowGroup>

    <!-- Either built-in prompt, in full. Monospace and selectable because the point is to be READ and forked,
         not admired; Claude's version is on show because a fork taken today is a snapshot, and knowing which
         build it came from is the only way to tell how old one is. -->
    <Dialog
        :visible="viewingBase !== undefined"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :header="viewingBase === `claude` ? `Claude Code's system prompt` : `Intentic's system prompt`"
        :style="{ width: '48rem', maxWidth: '95vw' }"
        @update:visible="viewingBase = undefined"
    >
        <div v-if="builtinBusy" class="flex items-center gap-2 py-6 text-xs text-muted">
            <Icon name="spinner" class="animate-spin" />
            Reading it from your sandbox…
        </div>
        <p v-else-if="builtinError !== undefined" :class="cmp.alertDanger()">{{ builtinError }}</p>
        <template v-else-if="viewingBase !== undefined && builtinPrompts[viewingBase] !== undefined">
            <p class="text-xs text-muted">
                <template v-if="viewingBase === `claude`">
                    Claude Code's own prompt, read out of the CLI in your sandbox
                    <span class="font-mono text-content">{{ builtinPrompts[viewingBase]?.version }}</span> — not a copy kept by this app. Choose
                    Claude and it keeps updating with the sandbox; fork it and you own it from here.
                </template>
                <template v-else>
                    Intentic's own prompt — the default, and the one we tune for this app. Choose Intentic and it keeps updating with the app; fork it
                    and you own it from here.
                </template>
                Either way, this app's own guidance about its question cards, checklist panel and browser tools is added on top; only a custom prompt
                drops that.
            </p>
            <pre class="mt-2 max-h-[55dvh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-2xs text-content">{{
                builtinPrompts[viewingBase]?.text
            }}</pre>
            <div class="mt-3 flex items-center justify-end gap-2">
                <CopyButton :text="builtinPrompts[viewingBase]?.text ?? ``" label="Copy" />
                <Button label="Edit a copy" size="small" @click="forkBuiltin(viewingBase)" />
            </div>
        </template>
    </Dialog>
</template>
