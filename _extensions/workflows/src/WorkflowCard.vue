<script setup lang="ts">
import { Card, Icon } from "@intentic/extension-ui";
import type { Workflow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { workflowLayers } from "./workflowDag";

/* ONE WORKFLOW AS A CARD — and the SAME card whether it is a design you have saved or a template you could.
 *
 * That is why this is a component rather than two blocks of markup. The gallery under the list used to be a
 * differently-shaped box holding a differently-shaped sentence, and nothing about it said "this is one of
 * those" — which is precisely what a template is. Drawn identically (dashed, because you do not own it yet), it
 * reads as a workflow you do not have, and picking one stops being a leap.
 *
 * IT DRAWS THE GRAPH RATHER THAN DESCRIBING IT. The row this replaces said "3 steps, branching" beside a
 * paragraph truncated to whatever width was left over — a sentence about a picture, where the picture is the
 * entire reason a workflow is a thing you keep. One column per generation, chips stacked where steps run side
 * by side, is the designer's own reading (workflowLayers) at a size that fits in a list: a fan-out looks like a
 * fan-out from across the room, and the words go back to being about the work.
 *
 * The description is a PROP rather than read off the workflow, because the gallery sells with a different
 * sentence than the design carries — a template's pitch is about its shape, a saved design's is about its job.
 */

const { workflow, description, dashed = false } = defineProps<{ workflow: Workflow; description?: string; dashed?: boolean }>();
const emit = defineEmits<{ open: [] }>();

// Past four columns the strip is a smear rather than a shape, and a long graph reads as "long" at four columns
// just as well as at nine. The designer is one click away for the rest.
const COLUMNS_SHOWN = 4;

const layers = computed(() => workflowLayers(workflow.steps));
const columns = computed(() => layers.value.slice(0, COLUMNS_SHOWN));
const beyond = computed(() => layers.value.slice(COLUMNS_SHOWN).reduce((total, layer) => total + layer.length, 0));

/* The two facts the picture cannot carry: how big it is, and how much of it happens at once. `maxParallel` is
 * only said where there is a fan-out to hold back — on a chain it is a number about nothing.
 */
const shape = computed(() => {
    const steps = `${workflow.steps.length} step${workflow.steps.length === 1 ? `` : `s`}`;
    const widest = Math.max(...layers.value.map((layer) => layer.length));
    return widest > 1 ? `${steps} · up to ${workflow.maxParallel} at once` : steps;
});
</script>

<template>
    <!-- `group/card` is what the quiet actions hang off: Run is always there, edit and delete appear under the
         pointer (see the list). -->
    <Card :dashed="dashed" class="group/card flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <button type="button" class="cursor-pointer truncate text-sm font-semibold text-content hover:underline" @click="emit(`open`)">
                        {{ workflow.name }}
                    </button>
                    <slot name="badges" />
                </div>
                <!-- Two lines, and clamped rather than truncated to one: a workflow's description is the only
                     place it says what it is FOR, and a sentence cut off at the width left over by four
                     controls was being shown without being readable. -->
                <p v-if="description" class="mt-1 line-clamp-2 text-xs leading-snug text-muted">{{ description }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1"><slot name="actions" /></div>
        </div>

        <!-- THE SHAPE. Scrolls rather than wraps: a wrapped graph is a different graph, and a strip that runs
             off the edge at least still says "there is more of this to the right". -->
        <div class="ui-softscroll flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <template v-for="(column, index) in columns" :key="index">
                <Icon v-if="index > 0" name="angle-right" class="shrink-0 text-2xs text-subtle" />
                <div class="flex shrink-0 flex-col gap-1">
                    <span
                        v-for="step in column"
                        :key="step.id"
                        class="max-w-44 truncate rounded-md border border-line bg-canvas px-2 py-1 text-2xs text-muted"
                        :title="step.title"
                    >
                        {{ step.title }}
                    </span>
                </div>
            </template>
            <span v-if="beyond > 0" class="shrink-0 text-2xs text-subtle">+{{ beyond }} more</span>
        </div>

        <!-- The footer is anchored at both ends — what the design IS on the left, how it last WENT on the right
             — so a column of cards has two things to scan down instead of one ragged line of grey. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
            <span>{{ shape }}</span>
            <div v-if="$slots[`meta`]" class="ml-auto flex items-center gap-3"><slot name="meta" /></div>
        </div>
    </Card>
</template>
