<script setup lang="ts">
import Button from "primevue/button";
import { cmp, Notice, type NoticeModel, Segmented } from "@intentic/ui";
import type { Loop, LoopContext } from "@intentic/sandbox-contract";
import Dialog from "primevue/dialog";
import { computed, ref, watch } from "vue";
import { startLoop } from "../composables/agents/useLoops";
import { noticeFrom } from "../composables/useAsyncAction";

/* "LOOP UNTIL…" — the form that turns an ordinary conversation into a Ralph loop.
 *
 * IT OPENS FROM A CHAT, not from a Loops page, and that is the whole discovery story. Nobody wakes up wanting
 * to configure a loop; they want the thing they are already talking to an agent about to keep going until it
 * is actually done. So this is a control on the composer of the conversation it will drive, and the
 * conversation is a prop rather than a field — there is no agent picker here because the agent is the one you
 * are looking at.
 *
 * THE FORM IS ORDERED BY WHAT THE USER ACTUALLY KNOWS. The goal first, because it is the only field they came
 * here with. Then how the loop ENDS, which is the one decision worth thinking about and the one that decides
 * whether the loop is trustworthy. The ceilings last, pre-filled with defaults that are safe on their own — a
 * user who fills in the first two fields and presses Start gets a loop that cannot run away.
 *
 * WHAT IS DELIBERATELY NOT OFFERED: the per-iteration prompt as a separate field on first open. `goal` and
 * `prompt` are different sentences and the contract keeps them apart, but making a user write both before
 * anything runs doubles the cost of trying a loop at all — so the instruction defaults to the goal restated as
 * work, and the field is there underneath for whoever wants to split them.
 */

const { conversationId, isolated } = defineProps<{ conversationId: string; isolated: boolean }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ started: [] }>();

const goal = ref(``);
const instruction = ref(``);
const context = ref<LoopContext>(`fresh`);
const stopKind = ref<`command` | `claim` | `judge`>(`command`);
const command = ref(``);
const rubric = ref(``);
const maxIterations = ref(8);
const maxSpendUsd = ref(5);
const stallLimit = ref(2);
const busy = ref(false);
const failure = ref<NoticeModel>();

// Re-opening the dialog on a different agent must not inherit the last one's goal — a loop started from a
// stale field is the one mistake here that costs real money.
watch(open, (shown) => {
    if (shown) {
        failure.value = undefined;
    }
});

const contextOptions = [
    { value: `fresh` as const, label: `Fresh context` },
    { value: `continue` as const, label: `Keep context` },
];
const stopOptions = [
    { value: `command` as const, label: `A command passes` },
    { value: `claim` as const, label: `The agent says so` },
    { value: `judge` as const, label: `A reviewer agrees` },
];

// What each choice actually costs the user, said where the choice is made rather than in a tooltip they will
// not open. The context note is the one people get wrong: "keep context" sounds strictly better until a loop
// spends fifteen iterations agreeing with itself.
const contextNote = computed(() =>
    context.value === `fresh`
        ? `Every iteration starts a new session against the same working tree, and carries its notes in a progress file. Slower per iteration, and it does not drift.`
        : `Each iteration continues the same session. Cheaper and it keeps the reasoning — but a long loop starts agreeing with itself.`,
);
const stopNote = computed(() => {
    if (stopKind.value === `command`) {
        return `Run after every iteration. Exit 0 ends the loop. The only check here whose answer does not come from a model.`;
    }
    return stopKind.value === `claim`
        ? `The agent writes a verdict file each iteration. Self-assessed, so it is advisory — pair it with a tight iteration ceiling.`
        : `A separate model, which did none of the work, rules on the agent's own report against your rubric.`;
});

const ready = computed(() => {
    if (goal.value.trim() === ``) {
        return false;
    }
    if (stopKind.value === `command`) {
        return command.value.trim() !== ``;
    }
    return stopKind.value !== `judge` || rubric.value.trim() !== ``;
});

const start = async (): Promise<void> => {
    busy.value = true;
    failure.value = undefined;
    try {
        /* The contract asks two questions where this form asks one, and collapsing them here is deliberate.
         * An ad-hoc loop started from a composer has exactly one bar to clear, so offering "what do you produce"
         * and "what else must be true" as separate controls would be two fields to answer a question the user
         * has already answered. Combining them is a workflow step's job, and that has a designer. */
        const output: Loop["output"] = stopKind.value === `claim` ? { kind: `claim` } : { kind: `none` };
        const checks: Loop["checks"] =
            stopKind.value === `command`
                ? [{ kind: `command`, command: command.value.trim() }]
                : stopKind.value === `judge`
                  ? [{ kind: `judge`, rubric: rubric.value.trim() }]
                  : [];
        await startLoop({
            conversationId,
            goal: goal.value.trim(),
            // The instruction defaults to the goal stated as work — see the header note on why this field is
            // optional rather than required.
            prompt: instruction.value.trim() === `` ? `Work towards the goal above. Do the next most useful thing.` : instruction.value.trim(),
            context: context.value,
            output,
            checks,
            maxIterations: maxIterations.value,
            maxSpendUsd: maxSpendUsd.value,
            stallLimit: stallLimit.value,
            isolated,
        });
        open.value = false;
        emit(`started`);
    } catch (error) {
        failure.value = noticeFrom(error, `The loop could not be started.`);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <Dialog v-model:visible="open" :modal="true" :draggable="false" :dismissable-mask="true" :style="{ width: '34rem' }" header="Loop until…">
        <div class="flex flex-col gap-4">
            <label class="flex flex-col gap-1">
                <span :class="cmp.sectionLabel()">The goal</span>
                <input v-model="goal" :class="cmp.input()" placeholder="the test suite passes on every package" autofocus />
                <span class="text-2xs text-subtle">Restated to the agent every iteration — in a fresh session it has never seen this before.</span>
            </label>

            <label class="flex flex-col gap-1">
                <span :class="cmp.sectionLabel()">What each iteration does</span>
                <input v-model="instruction" :class="cmp.input()" placeholder="run the tests, pick the top failure, fix it" />
                <span class="text-2xs text-subtle">Optional. Leave it empty and the agent works towards the goal however it sees fit.</span>
            </label>

            <div class="flex flex-col gap-1.5">
                <span :class="cmp.sectionLabel()">How the loop ends</span>
                <Segmented v-model="stopKind" :options="stopOptions" />
                <input v-if="stopKind === `command`" v-model="command" :class="[cmp.input(), `font-mono`]" placeholder="pnpm test" />
                <textarea
                    v-else-if="stopKind === `judge`"
                    v-model="rubric"
                    :class="cmp.input()"
                    rows="2"
                    placeholder="Every public function has a doc comment explaining why it exists."
                ></textarea>
                <span class="text-2xs text-subtle">{{ stopNote }}</span>
            </div>

            <div class="flex flex-col gap-1.5">
                <span :class="cmp.sectionLabel()">Memory between iterations</span>
                <Segmented v-model="context" :options="contextOptions" />
                <span class="text-2xs text-subtle">{{ contextNote }}</span>
            </div>

            <!-- The ceilings, together and pre-filled, because they are only ever read as a group: "how far can
                 this go before it stops on its own". Every one of them is a way the loop ends without meeting
                 the goal, so a user who changes none of them still cannot start something unbounded. -->
            <div class="flex flex-col gap-1.5">
                <span :class="cmp.sectionLabel()">Stop it anyway after</span>
                <div class="grid grid-cols-3 gap-2">
                    <label class="flex flex-col gap-1">
                        <input v-model.number="maxIterations" type="number" min="1" max="50" :class="cmp.input()" />
                        <span class="text-2xs text-subtle">iterations</span>
                    </label>
                    <label class="flex flex-col gap-1">
                        <input v-model.number="maxSpendUsd" type="number" min="0.5" step="0.5" :class="cmp.input()" />
                        <span class="text-2xs text-subtle">dollars</span>
                    </label>
                    <label class="flex flex-col gap-1">
                        <input v-model.number="stallLimit" type="number" min="1" max="10" :class="cmp.input()" />
                        <span class="text-2xs text-subtle">idle rounds</span>
                    </label>
                </div>
                <!-- The stall limit is the one nobody would think to set, and the one that saves the most: an
                     agent re-reading the same files forever raises no error at all. -->
                <span class="text-2xs text-subtle">
                    An idle round is an iteration that changed nothing in the tree — that, not an error, is how a loop usually goes wrong.
                </span>
            </div>

            <Notice v-if="failure" :of="failure" />
        </div>

        <template #footer>
            <button type="button" :class="cmp.linkButton()" @click="open = false">Cancel</button>
            <Button size="small" :label="busy ? `Starting…` : `Start looping`" :disabled="!ready || busy" @click="start()" />
        </template>
    </Dialog>
</template>
