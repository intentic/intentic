<script setup lang="ts">
import { type AgentRunPin, parsePinned, quickModelKey } from "@intentic/sandbox-contract";
import { Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { computed, shallowRef } from "vue";
import { modelChoiceLabel } from "../../../composables/chat/modelPins";
import { useQuickModel } from "../../../composables/chat/quickModel";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import AddModelButton from "./AddModelButton.vue";
import { pinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import ModelPinPicker from "./ModelPinPicker.vue";

/* THE JUDGE ITSELF, as distinct from the policy it reads: whether it runs, and which model runs it.
 *
 * WHY THIS GROUP EXISTS. The policy below is the interesting half and it is where all the attention went, which
 * left the tier that actually spends money and interrupts people with no controls at all. It could not be turned
 * off, and there was no way to see which model was reaching the verdicts — so an owner whose gate asked about
 * the wrong things had exactly one move, editing prose and hoping. Two settings, and they answer the two
 * questions somebody in that position actually has: can I stop this, and can I give it a better model.
 *
 * IT SITS ABOVE THE POLICY, because it is the switch over it: a policy read by nothing is a document, and
 * nobody should read three paragraphs about what to write before finding out that nothing is reading it.
 *
 * WATCH IS THE POINT OF THE CONTROL rather than a halfway house, the same argument the Automatic tier's Measure
 * state makes on the Models page. Nobody trusts a judge they have not watched, and the only evidence that it
 * asks about the right things is a log of what it decided while it could not interrupt anybody — which is
 * exactly the list sitting under the policy on this page.
 */

const { settings, patch } = useSandboxSettings();
const quickModel = useQuickModel();

/* Three states in the order they escalate, worded for what each DOES. "Watch" is the honest name for a mode
 * whose whole content is that a verdict is written down and nothing happens to the command. */
const MODES = [
    { label: `Off`, value: `off` },
    { label: `Watch`, value: `watch` },
    { label: `On`, value: `on` },
];

const mode = computed(() => settings.value?.commandJudge ?? `on`);

/* THE MODEL, stored exactly as the quick model's list is (`${provider}:${model}` keys) and edited by the same
 * four gestures, so the row behaves like the ones on the Models page it deliberately does not live on: which
 * model judges a command is a safety question, and reading it three tabs away from the policy it applies would
 * be filing it under cost. */
const judge = pinnedList({
    read: () => settings.value?.commandJudgeModels ?? [],
    write: (keys) => patch({ commandJudgeModels: [...keys] }),
    decode: (key) => parsePinned(key),
    encode: (pin) => quickModelKey(pin),
});

// What answers while the list is empty: the sandbox's own quick chain, spelled out in the order it would be
// walked, because "Auto" on its own does not tell anybody which account their verdicts are being billed to.
const fallbackOrder = computed(() => quickModel.chain.value.map(modelChoiceLabel));

const editing = shallowRef<{ index: number | undefined; anchor: HTMLElement } | undefined>(undefined);
const openPicker = (index: number | undefined, anchor: HTMLElement): void => {
    editing.value = { index, anchor };
};
const editingPin = computed<AgentRunPin | undefined>(() =>
    editing.value?.index === undefined ? undefined : judge.entries.value[editing.value.index]?.pin,
);
</script>

<template>
    <RowGroup label="Safety judge">
        <RowNote>
            Before a flagged command runs, a model reads your policy below and decides whether to allow it, ask you, or refuse it. This is whether
            that happens, and which model does it.
        </RowNote>

        <Row icon="shield" title="When to judge" description="Whether a verdict can stop a command.">
            <template #control>
                <SegmentedControl
                    :model-value="mode"
                    :options="MODES"
                    @update:model-value="(commandJudge: string) => patch({ commandJudge: commandJudge as `off` | `watch` | `on` })"
                />
            </template>
            <template #below>
                <div class="flex flex-col gap-2">
                    <p v-if="mode === `off`" class="text-2xs text-muted">
                        Nothing is judged, nothing is recorded, and no card is raised. Your policy is not read at all.
                    </p>
                    <p v-else-if="mode === `watch`" class="text-2xs text-muted">
                        Every flagged command is judged and the verdict is recorded below, and nothing is ever held. Read a few days of
                        <span class="text-content">Recent decisions</span> to see what your policy would have stopped before letting it stop
                        anything.
                    </p>
                    <p v-else class="text-2xs text-muted">The verdict decides: allowed silently, held on a card, or refused.</p>

                    <!-- The floor under all three, said where somebody turning the judge off will read it. Without
                         this, "Off" reads as switching the gate off entirely, which it is not and must not be
                         mistaken for. It is the same promise the policy's own notice makes, and it holds here. -->
                    <Notice v-if="mode !== `on`" tone="info" class="text-2xs">
                        Wiping a block device, or deleting anything under <code>/history</code>, still asks. That rule is typed rather than judged,
                        so no setting here reaches it.
                    </Notice>
                </div>
            </template>
        </Row>

        <Row icon="sparkles" title="Judge model" description="Which model reads the policy.">
            <template #control>
                <AddModelButton
                    label="Add a model for the safety judge"
                    :disabled="settings === undefined || mode === `off`"
                    @open="(anchor: HTMLElement) => openPicker(undefined, anchor)"
                />
            </template>
            <template #below>
                <div class="flex flex-col gap-2">
                    <ModelPinList
                        v-if="judge.entries.value.length > 0"
                        :entries="judge.entries.value"
                        @promote="judge.promote"
                        @remove="judge.remove"
                        @edit="(index: number, anchor: HTMLElement) => openPicker(index, anchor)"
                    />
                    <!-- The floor, named in full rather than as the word "Auto": these verdicts are billed to one
                         of your accounts, and which one is the thing this row exists to make readable. The
                         invitation to change it is dropped while the judge is off, because the control that would
                         do it is disabled an inch away and a row may not ask for a press it has just refused. -->
                    <p v-else-if="fallbackOrder.length > 0" class="text-2xs text-muted">
                        <span class="text-content">Your quick model</span>: {{ fallbackOrder.join(`, then `) }}.<template v-if="mode !== `off`">
                            Add a model to judge commands on a different one.</template
                        >
                    </p>
                    <p v-else-if="settings !== undefined" class="text-2xs text-muted">
                        Connect an AI account above to give the judge something to run on. Until then every flagged command falls back to the
                        standing rule alone.
                    </p>

                    <!-- The one thing worth saying about the choice, and it is not "pick a cheap one": this is the
                         only automatic job whose input may have been written by whoever the agent was reading. -->
                    <p v-if="mode === `off`" class="text-2xs text-subtle">Nothing judges commands at the moment, so this is not in use.</p>
                    <p v-else class="text-2xs text-subtle">
                        Worth a better model than the rest of the automatic jobs: it reads the command as data, and on a turn that has taken in
                        something from outside, that text may be arguing for its own approval.
                    </p>
                </div>
            </template>
        </Row>
    </RowGroup>

    <!-- One panel for the group, opened over whichever trigger raised it. Mounted rather than created per open
         because the overlay hosts inside it measure and place themselves in a watcher on that flag. No knobs:
         a one-shot judgment is run with thinking off and no effort at all (agent/one-shot.ts), so a reasoning
         control here would be a switch with nothing behind it. -->
    <ModelPinPicker
        :open="editing !== undefined"
        :anchor="editing?.anchor"
        :pin="editingPin"
        :taken="judge.taken.value"
        @update:open="editing = undefined"
        @pick="(pin: AgentRunPin) => judge.apply(editing?.index, pin)"
    />
</template>
