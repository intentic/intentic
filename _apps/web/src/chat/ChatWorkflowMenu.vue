<script setup lang="ts">
import { Icon } from "@intentic/ui";
import type { Workflow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { useWorkflowRuns } from "../composables/agents/useWorkflowRuns";

/* THE COMPOSER'S WORKFLOW PICKER — "run what I just typed through this design instead of through this chat".
 *
 * WHY THE COMPOSER IS THE RIGHT PLACE, and not the workflows page. A saved workflow is a SHAPE — "two models
 * on one task", "reproduce it, fix it, lock it in" — and the shape is worth keeping precisely because the task
 * is different every time. Before this, pointing one at today's job meant opening the designer and retyping a
 * step's prompt, which made the design and the request the same document: you could not run the same shape
 * twice without editing it, and the edit was the thing you would forget to undo. The request belongs to the
 * RUN, and the place a person writes a request is the box they are already typing in.
 *
 * It is the loop pill's neighbour for the same reason the loop pill sits where it does: both change what the
 * next message IS. Loop runs it over and over; this runs it through a graph of sessions that are not this one.
 */

const emit = defineEmits<{ picked: [workflow: Workflow] }>();

const { designs } = useWorkflowRuns();

// The shape, in the words the workflows page uses for it — so a design recognised there is the same one here.
const shapeOf = (workflow: Workflow): string => {
    const roots = workflow.steps.filter((step) => step.needs.length === 0).length;
    const widest = Math.max(1, ...workflow.steps.map((step) => workflow.steps.filter((other) => other.needs.includes(step.id)).length));
    const count = `${workflow.steps.length} step${workflow.steps.length === 1 ? `` : `s`}`;
    if (workflow.steps.length === 1) {
        return count;
    }
    return roots > 1 || widest > 1 ? `${count}, branching` : `${count} in a line`;
};

// Which providers this design pins, named once each. The one fact worth carrying into a picker row: a design
// that runs two different models is the reason somebody keeps a workflow at all, and it is invisible in a name.
const pinned = (workflow: Workflow): string[] => [...new Set(workflow.steps.flatMap((step) => (step.agent === undefined ? [] : [step.agent])))];

const empty = computed(() => designs.value.length === 0);
</script>

<template>
    <div class="flex flex-col p-1">
        <!-- Nothing saved is not an error and does not get an error's chrome: a workspace that has never opened
             the workflows page has no designs, which is the ordinary state, and the sentence's job is to say
             where they come from. -->
        <p v-if="empty" class="px-2.5 py-3 text-2xs text-subtle">
            No workflows saved yet. Design one on the Workflows page — then whatever you type here runs through it.
        </p>
        <button
            v-for="workflow in designs"
            :key="workflow.id"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="emit(`picked`, workflow)"
        >
            <Icon name="sitemap" class="mt-0.5 shrink-0 text-xs text-subtle" />
            <span class="flex min-w-0 flex-col">
                <span class="flex min-w-0 items-baseline gap-1.5">
                    <span class="truncate text-sm text-content md:text-xs">{{ workflow.name }}</span>
                    <span class="shrink-0 text-2xs text-subtle">{{ shapeOf(workflow) }}</span>
                </span>
                <span v-if="workflow.description" class="line-clamp-2 text-2xs text-subtle">{{ workflow.description }}</span>
                <span v-if="pinned(workflow).length > 0" class="truncate text-2xs text-subtle">on {{ pinned(workflow).join(` · `) }}</span>
            </span>
        </button>
    </div>
</template>
