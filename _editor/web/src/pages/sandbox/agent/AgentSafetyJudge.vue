<script setup lang="ts">
import { Button, Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { modelChoiceLabel } from "../../../composables/chat/modelPins";
import { useRoleModel } from "../../../composables/chat/roleModel";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* THE SWITCH OVER THE SAFETY JUDGE: whether it runs at all, and — read-only — what it is running on.
 *
 * WHY THIS GROUP EXISTS. The policy below is the interesting half and it is where all the attention went, which
 * left the tier that actually spends money and interrupts people with no control at all. It could not be turned
 * off, so an owner whose gate asked about the wrong things had exactly one move: editing prose and hoping.
 *
 * IT SITS ABOVE THE POLICY, because it is the switch over it: a policy read by nothing is a document, and
 * nobody should read three paragraphs about what to write before finding out that nothing is reading it.
 *
 * WATCH IS THE POINT OF THE CONTROL rather than a halfway house, the same argument the automatic tier's Measure
 * state makes on the Models tab. Nobody trusts a judge they have not watched, and the only evidence that it asks
 * about the right things is a log of what it decided while it could not interrupt anybody — which is exactly the
 * list sitting under the policy on this page.
 *
 * THE MODEL IS NAMED HERE AND CHOSEN ON MODELS, and that split is deliberate rather than an oversight. The
 * picker used to be in this group, on the argument that which model judges a command is a safety question and
 * reading it three tabs away would be filing it under cost. What that argument missed is the reader who does not
 * yet know the judge exists: it put a model picker on a tab called Safety and left "where do I choose a model"
 * with two answers, which is a worse failure than a link. So the choice moved to the one page that owns every
 * model, and what stays here is the fact somebody reading a policy actually needs — WHICH model is applying it,
 * named in full, billed to which account. Reading it costs nothing; changing it costs one press. */

const { settings, patch } = useSandboxSettings();
const judge = useRoleModel(`safety-judge`);

/* Three states in the order they escalate, worded for what each DOES. "Watch" is the honest name for a mode
 * whose whole content is that a verdict is written down and nothing happens to the command. */
const MODES = [
    { label: `Off`, value: `off` },
    { label: `Watch`, value: `watch` },
    { label: `On`, value: `on` },
];

const mode = computed(() => settings.value?.commandJudge ?? `on`);

/* WHAT WILL ACTUALLY READ THE POLICY, in the order it will be walked: the RESOLVED chain for the `safety-judge`
 * role, which is the owner's own list minus any entry whose account has gone.
 *
 * The resolved chain rather than the stored setting, because the distinction a reader needs here is not what is
 * written down — it is which model is about to read their policy and whose account pays for the verdict.
 *
 * EMPTY IS A REAL AND COMMON STATE now that nothing is derived for an unset job: the judge can be switched on
 * and still have no model, in which case it does not run and the standing rule alone decides. That is the one
 * thing a reader of this policy most needs to be told, so the row says it rather than describing a ladder this
 * app picked. */
const judgeChain = computed<readonly string[]>(() => judge.chain.value.map(modelChoiceLabel));
</script>

<template>
    <RowGroup label="Safety judge">
        <RowNote>
            Before a flagged command runs, a model reads your policy below and decides whether to allow it, ask you, or refuse it. This is whether
            that happens.
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
                    <!-- No emphasis span on "What gets stopped": inside a toned Notice, `text-content` paints
                         near-black over the tone's own colour and reads as a bug rather than as a highlight.
                         The group name carries itself. -->
                    <Notice v-if="mode !== `on`" tone="info" class="text-2xs">
                        Wiping a block device, deleting <code>/</code>, or deleting anything under <code>/history</code> still asks — and on your own
                        computers, so does any delete. Those rules are typed rather than judged, so no setting here reaches them. They are listed
                        under “What gets stopped” below.
                    </Notice>
                </div>
            </template>
        </Row>

        <!-- WHAT IS APPLYING THE POLICY, stated rather than editable. A reader deciding whether to trust the
             document below has one question about the model, and it is which one, not which four gestures edit
             the list. The press that changes it is a link rather than a picker, because every model in this
             sandbox is chosen in the same place. -->
        <Row icon="sparkles" title="Judge model" description="Which model reads the policy.">
            <!-- A PLACE, SO A LINK, DRAWN AS A BUTTON. It sits in the control column, where every sibling is a
                 bordered segmented control or a picker, and bare link text there reads as a caption rather than
                 as something pressable — which on the one row whose control lives elsewhere is the exact wrong
                 impression. `as` keeps the anchor and the address (hover shows where it goes, ⌘-click opens
                 Models in another tab) while the kit owns the geometry and the hover state. -->
            <template #control>
                <Button :as="RouterLink" :to="{ name: `sandbox`, params: { tab: `agent` }, query: {} }" size="small" :text="true">
                    Change in Models
                </Button>
            </template>
            <template #below>
                <div class="flex flex-col gap-2">
                    <p v-if="mode === `off`" class="text-2xs text-subtle">Nothing judges commands at the moment, so no model is in use.</p>
                    <p v-else-if="judgeChain.length > 0" class="text-2xs text-muted">
                        <span class="text-content">Judged by</span>: {{ judgeChain.join(`, then `) }}.
                    </p>
                    <!-- SWITCHED ON WITH NOTHING TO RUN, which is what the row says instead of naming a model
                         this app chose. Nothing is derived for an empty list any more, so the judge is on and
                         inert until somebody sets one — a state that has to be readable from here, since this
                         is the page where the policy it would read is being written. -->
                    <p v-else-if="settings !== undefined" class="text-2xs text-warning">
                        <span class="font-medium">No model is set for the judge</span>, so nothing reads your policy and every flagged command falls back
                        to the standing rule alone. Set one in Models.
                    </p>

                    <!-- The one thing worth saying about the choice, said where the choice is being weighed
                         rather than where it is made: this is the only automatic job whose input may have been
                         written by whoever the agent was reading. -->
                    <p v-if="mode !== `off`" class="text-2xs text-subtle">
                        Worth a better model than the rest of the automatic jobs: it reads the command as data, and on a turn that has taken in
                        something from outside, that text may be arguing for its own approval.
                    </p>
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
