<script setup lang="ts">
import type { BuiltinPromptText, SystemPromptMode } from "@intentic/sandbox-contract";
import { ui, CopyButton, Modal, Notice, Row, RowGroup, SegmentedControl } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { sandboxJson } from "../../../composables/sandbox/sandboxClient";
import { useSavings } from "../../../composables/sandbox/useSavings";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { useDraft } from "../../../composables/useDraft";
import { asPercent } from "./numberInputs";
import { promptReach, spokenList } from "./promptReach";
import { verdictsOf } from "../savingsChart";
import InstructionsInfo from "./InstructionsInfo.vue";
import MeasurementPanel, { type PanelReading } from "./MeasurementPanel.vue";

/* WHAT THE ASSISTANT IS TOLD, before the user types anything: how much it writes back, and which prompt it IS.
 * The two are one group because the second SUPERSEDES the first: a custom prompt drops the terse steer along
 * with everything else the daemon appends, and a setting that can silently switch off the setting above it
 * belongs next to it, saying so. */

const { settings, patch, save } = useSandboxSettings();
const { savings } = useSavings({});

/* --- System prompt -------------------------------------------------------------------------------------------
 * Three bases: Intentic's own (the default), Claude Code's, or one the owner writes. The first two are peers:
 * a base plus the harness wiring this app appends, and picking between them is a one-click preference. The
 * third replaces everything, which is why it is the only one that argues back.
 *
 * A prompt picker is a trap unless you can READ what each option is, so either built-in text is one click away
 * and either can be forked into a custom one. They are fetched ON DEMAND: Claude's costs a throwaway CLI turn
 * daemon-side (preset-prompt.ts): cheap, but not something every visit to this tab should pay for.
 *
 * The draft is LOCAL rather than a computed over settings: saving is a whole-object POST that every other
 * control on this page renders from, and the text is a system prefix every live conversation is caching, so a
 * per-keystroke save would thrash both. It commits on blur (the textarea's own `change`) or from the Save
 * button, which is there because a save nobody can see is a save nobody trusts. */
const PROMPT_MAX = 20000; // SandboxSettingsSchema.systemPrompt's cap: the daemon rejects more.
const PROMPT_MODES: { label: string; value: SystemPromptMode }[] = [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
    { label: `Custom`, value: `custom` },
];
const promptMode = computed<SystemPromptMode>(() => settings.value?.systemPromptMode ?? `intentic`);
// Seeded from the saved prompt, followed across other windows' saves, never over an edit here: see useDraft,
// whose seeding rule was extracted from the bug this row hit (an empty draft blocking its own initial seed).
const prompt = useDraft(() => settings.value?.systemPrompt);
const promptDirty = computed(() => settings.value !== undefined && prompt.value !== settings.value.systemPrompt);

const savePrompt = (): void => {
    // Normalise BEFORE the dirty check, not inside the payload: saving a trimmed copy of an untrimmed draft
    // leaves the two permanently unequal, and the row would sit there claiming unsaved changes forever.
    prompt.value = prompt.value.trim();
    if (promptDirty.value) {
        patch({ systemPrompt: prompt.value });
    }
};
// Switching base saves at once: it is a picker, not a draft. An unsaved custom edit is carried along rather
// than discarded: coming back to Custom finds the text still there, and it is only committed by Save.
const setPromptMode = (mode: string): void => patch({ systemPromptMode: mode as SystemPromptMode });

// The two built-in prompts, as text (GET /settings/system-prompt/{base}). Cached per base once fetched, so
// reopening the dialog is instant and forking doesn't re-fetch.
const builtinPrompts = ref<Partial<Record<string, BuiltinPromptText>>>({});
const viewingBase = ref<`intentic` | `claude` | undefined>(undefined);
const { busy: builtinBusy, notice: builtinError, run: runBuiltin } = useAsyncAction();
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
/* COMPARING IS DONE IN THE READER, not from the row. It used to be a third link beside "View this prompt":
 * which put two ways to open one dialog next to each other and made the row's action cluster read as three
 * peers, when it is really "read them" and "fork one". Comparison also cannot happen on a settings row: the
 * two prompts are thousands of words each, so it is inherently a thing you do inside the thing that shows
 * them. The switcher in the dialog IS the comparison. */
// The SAME two words the mode picker on the row uses, so a name means one thing on both controls.
const VIEW_BASES = [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
];
const setViewingBase = (base: string): void => void viewBuiltin(base as `intentic` | `claude`);

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

/* What the experiment says so far, worded exactly as the Savings card words it: same report, same sentence.
 * The steer is judged on the PROSE it steers, not on the turn's output tokens, which are nine parts tool-call
 * arguments and could never show it; this row used to name the tokens and was reporting the wrong quantity.
 *
 * Zipped against the experiment's own readings rather than taking `[0]`, so a metric added to the report lands
 * under the headline instead of going unmentioned. <MeasurementPanel> owns how the ranks are drawn. */
const terseReadings = computed<PanelReading[]>(() => {
    const experiment = savings.value?.output;
    if (experiment === undefined) {
        return [];
    }
    const { headline, also } = verdictsOf(experiment);
    return [headline, ...also].flatMap((verdict, index) => {
        const reading = experiment.metrics[index];
        return reading === undefined ? [] : [{ verdict, on: reading.on.turns, off: reading.off.turns }];
    });
});

/* WHO THIS SETTING ACTUALLY REACHES, said on the control rather than only inside the (i). It was the one thing
 * the row did not say and the one thing a reader cannot find out any other way: a turn on a provider's own
 * runtime that ignored the prompt looked exactly like one that honoured it. Derived from the same record the
 * daemon composes against (promptReach.ts), so the sentence cannot drift from the behaviour.
 *
 * ONE LINE, not the three sentences it was. The third: that an agent you install yourself keeps its own
 * prompt, is said in two better places already: the (i)'s table, and the model picker on the very chat it
 * would affect. Repeating it here bought nothing and cost the row its scannability. */
const reach = promptReach();
/* Assembled here rather than in the template. Written inline it needs a `<template v-if>` mid-sentence and the
 * whitespace gymnastics that go with it (`}}<template …></template\n>.`), which is unreadable and one stray
 * newline away from printing a space before the full stop. */
const reachLine =
    reach.adds.length > 0
        ? `Replaces the prompt on ${spokenList(reach.replaces)} · added to theirs on ${spokenList(reach.adds)}.`
        : `Replaces the prompt on ${spokenList(reach.replaces)}.`;
</script>

<template>
    <RowGroup label="Instructions">
        <template #info><InstructionsInfo /></template>

        <!-- Terse responses: steers the assistant to answer concisely (no restating context/tool output),
             cutting its own output tokens. A stable system-prompt suffix, so it doesn't hurt prompt-cache hits. -->
        <Row
            icon="align-left"
            title="Terse responses"
            description="Ask the assistant to answer concisely without restating context: fewer output tokens per reply."
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
                <!-- A LINE, NOT A BOX. The row below already raises a tinted notice about the same decision, and
                     two warning panels stacked inside one group read as an alarm rather than as a hierarchy:
                     the colour alone carries a sentence this short. -->
                <p v-if="promptMode === `custom`" class="text-2xs text-warning">
                    Not applied while your own system prompt is set: say it in the prompt below instead.
                </p>
                <!-- The steer's measurement control. Unlike a cleaned command, which carries its own raw
                     baseline, a turn cannot be re-run to see what it would have said unsteered, so the only
                     way to know what this switch is worth is to leave a slice of turns unsteered and compare.
                     WHY that is so is the (i)'s job; the row says only what the box does. -->
                <MeasurementPanel
                    v-else-if="settings?.terseOutput === true"
                    :percent="terseHoldoutPercent"
                    :readings="terseReadings"
                    note="Runs this share of turns without it, as a control."
                    on-label="steered"
                    off-label="unsteered"
                    @commit="(terseHoldout: number) => patch({ terseHoldout })"
                />
            </template>
        </Row>

        <!-- System prompt, which prompt the agent IS. Two built-in bases the app maintains, and an escape
             hatch that replaces them. It sits directly under Terse responses because Custom SUPERSEDES it:
             that mode drops the steer along with everything else, and the row above says so when it does.

             THE ACTIONS COME FIRST under the control, and the reach fact is a footnote under them. It was the
             other way round: three sentences of provider facts, then three same-sized text links, so the
             only things on the row you can actually DO were the last thing found, in the weakest affordance
             the page has. -->
        <Row icon="pencil" title="System prompt">
            <template #description>
                <template v-if="promptMode === `custom`">Your own prompt: the agent runs on this text alone.</template>
                <template v-else-if="promptMode === `claude`">Claude Code's own prompt, as shipped in your sandbox's CLI.</template>
                <template v-else>Intentic's own prompt, tuned for this app.</template>
            </template>
            <template #control>
                <SegmentedControl :model-value="promptMode" :options="PROMPT_MODES" @update:model-value="setPromptMode" />
            </template>
            <template #below>
                <!-- A base is read, not edited: these two are the whole surface. Real buttons rather than
                     inline links: they are the row's actions, and a text link at 11px under a paragraph of
                     11px text is indistinguishable from the paragraph. -->
                <template v-if="promptMode !== `custom`">
                    <div class="flex flex-wrap items-center gap-2">
                        <Button label="View prompt" size="small" severity="secondary" @click="viewBuiltin(promptMode)" />
                        <Button label="Edit a copy" size="small" severity="secondary" :loading="builtinBusy" @click="forkBuiltin(promptMode)" />
                    </div>
                    <!-- WHO IT REACHES, as one line. Two clauses because the two answers are genuinely
                         different promises, and a reader on Grok who saw only "applies to Codex, Grok and
                         Claude" would expect a replacement they are not getting. -->
                    <p class="mt-2 text-2xs text-subtle">{{ reachLine }}</p>
                </template>

                <template v-else>
                    <textarea
                        v-model="prompt"
                        rows="5"
                        :maxlength="PROMPT_MAX"
                        :disabled="settings === undefined"
                        placeholder="Write the assistant's system prompt, or start from one of the built-in prompts below."
                        :class="ui.input('w-full resize-y font-mono text-xs')"
                        aria-label="System prompt"
                        @change="savePrompt"
                    ></textarea>

                    <!-- What Custom actually costs, shown while they are in it rather than discovered later
                         when the chat's cards quietly stop appearing. Trimmed to the consequence and the
                         inventory: the full kept/lost tables are the (i)'s, which has room to lay them out
                         side by side instead of running them together in a tinted paragraph. -->
                    <Notice tone="warning" class="mt-2 text-2xs">
                        Your text becomes the whole prompt on {{ spokenList(reach.replaces) }}: including what this app tells the assistant about its
                        own question cards, checklist panel and browser tools. Terse responses stops applying.
                        <template v-if="reach.adds.length > 0">On {{ spokenList(reach.adds) }} it is added to their prompt instead.</template>
                    </Notice>

                    <div class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                        <span class="flex flex-wrap items-center gap-2">
                            <Button
                                label="Start from Intentic's"
                                size="small"
                                severity="secondary"
                                :loading="builtinBusy"
                                @click="forkBuiltin(`intentic`)"
                            />
                            <Button
                                label="Start from Claude's"
                                size="small"
                                severity="secondary"
                                :loading="builtinBusy"
                                @click="forkBuiltin(`claude`)"
                            />
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
                <Notice v-if="builtinError !== undefined" :of="builtinError" class="mt-2" />
            </template>
        </Row>
    </RowGroup>

    <!-- EITHER BUILT-IN PROMPT, AND THE SWITCH BETWEEN THEM. Monospace and selectable because the point is to
         be READ and forked, not admired; Claude's version is on show because a fork taken today is a snapshot,
         and knowing which build it came from is the only way to tell how old one is.

         The base switcher is what "compare" means here: two prompts of a few thousand words each are compared
         by reading one and then the other, which is a thing that can only happen inside the reader. -->
    <Modal :open="viewingBase !== undefined" size="lg" header="Built-in system prompts" @update:open="viewingBase = undefined">
        <SegmentedControl
            v-if="viewingBase !== undefined"
            :model-value="viewingBase"
            :options="VIEW_BASES"
            aria-label="Which built-in prompt to read"
            @update:model-value="setViewingBase"
        />
        <div v-if="builtinBusy" class="flex items-center gap-2 py-6 text-xs text-muted">
            <Icon name="spinner" class="animate-spin" />
            Reading it from your sandbox…
        </div>
        <Notice v-else-if="builtinError !== undefined" :of="builtinError" class="mt-3" />
        <template v-else-if="viewingBase !== undefined && builtinPrompts[viewingBase] !== undefined">
            <p class="mt-3 text-xs text-muted">
                <template v-if="viewingBase === `claude`">
                    Claude Code's own prompt, read out of the CLI in your sandbox
                    <span class="font-mono text-content">{{ builtinPrompts[viewingBase]?.version }}</span>, not a copy kept by this app. Choose
                    Claude and it keeps updating with the sandbox; fork it and you own it from here.
                </template>
                <template v-else>
                    Intentic's own prompt: the default, and the one we tune for this app. Choose Intentic and it keeps updating with the app; fork it
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
    </Modal>
</template>
