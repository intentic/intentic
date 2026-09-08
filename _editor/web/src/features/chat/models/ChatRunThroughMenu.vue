<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { type LoopDesign, type Workflow, loopDesignLine } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { useLoopDesigns } from "../../agents/fleet/useLoopDesigns";
import { useWorkflowRuns } from "../../agents/fleet/useWorkflowRuns";

// One control, one list, two headed sections: a loop and a workflow answer the same question (what happens to this
// message on send), so picking one replaces the other. A loop row keeps its stop condition and ceilings; a workflow row
// keeps its shape and pinned models, since that's why either is kept.

const { loop, workflow } = defineProps<{ loop?: string; workflow?: string }>();
const emit = defineEmits<{ loop: [design: LoopDesign | undefined]; workflow: [design: Workflow | undefined]; manage: [] }>();

const { designs: loops } = useLoopDesigns();
const { designs: workflows } = useWorkflowRuns();

// The shape, in the words the workflows page uses for it, so a design recognised there is the same one here.
const shapeOf = (design: Workflow): string => {
    const roots = design.steps.filter((step) => step.needs.length === 0).length;
    const widest = Math.max(1, ...design.steps.map((step) => design.steps.filter((other) => other.needs.includes(step.id)).length));
    const count = `${design.steps.length} step${design.steps.length === 1 ? `` : `s`}`;
    if (design.steps.length === 1) {
        return count;
    }
    return roots > 1 || widest > 1 ? `${count}, branching` : `${count} in a line`;
};

// Which providers a design pins, named once each: a workflow running several models is invisible in its name otherwise.
const pinned = (design: Workflow): string[] => [...new Set(design.steps.flatMap((step) => (step.agent === undefined ? [] : [step.agent])))];

const picked = computed(() => loop !== undefined || workflow !== undefined);
const empty = computed(() => loops.value.length === 0 && workflows.value.length === 0);
</script>

<template>
    <div class="flex flex-col p-1">
        <!--
            An empty workspace is ordinary, not an error, so the sentence says what a loop and workflow ARE rather than
            just reporting absence.
        -->
        <p v-if="empty" class="px-2.5 py-3 text-2xs text-subtle">
            Nothing saved yet. A <strong class="font-medium text-muted">loop</strong> sends your message over and over: fixing, checking, fixing:
            until something you can state is true. A <strong class="font-medium text-muted">workflow</strong> hands it to a design of several sessions
            instead of to this chat.
        </p>

        <!--
            The way back to an ordinary message; must be a row in this list, since the pill itself is just a badge. One
            row clears both kinds at once.
        -->
        <button
            v-if="picked"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="
                emit(`loop`, undefined);
                emit(`workflow`, undefined);
            "
        >
            <Icon name="times" class="mt-0.5 shrink-0 text-xs text-subtle" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">Just this chat</span>
                <span class="text-2xs text-subtle">Send once, as an ordinary message.</span>
            </span>
        </button>

        <!--
            Each section's heading is a sentence, not a label: it teaches the difference at the moment of choosing. A
            heading hides with its section, so a workspace with only loops reads as a loop picker.
        -->
        <template v-if="loops.length > 0">
            <p class="px-2.5 pt-2 pb-1 text-2xs font-medium text-subtle">Repeat it here, until it's done</p>
            <button
                v-for="design in loops"
                :key="design.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': design.id === loop }"
                @click="emit(`loop`, design)"
            >
                <Icon name="repeat" class="mt-0.5 shrink-0 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm text-content md:text-xs">{{ design.name }}</span>
                    <!--
                        How it ends and how far it may go, computed from the loop; a control starting paid work must
                        say what stops it up front.
                    -->
                    <span class="truncate text-2xs text-subtle">{{ loopDesignLine(design) }}</span>
                    <span v-if="design.description" class="line-clamp-2 text-2xs text-subtle">{{ design.description }}</span>
                </span>
            </button>
        </template>

        <template v-if="workflows.length > 0">
            <p class="px-2.5 pt-2 pb-1 text-2xs font-medium text-subtle">Hand it to other sessions</p>
            <button
                v-for="design in workflows"
                :key="design.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': design.id === workflow }"
                @click="emit(`workflow`, design)"
            >
                <Icon name="sitemap" class="mt-0.5 shrink-0 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span class="truncate text-sm text-content md:text-xs">{{ design.name }}</span>
                        <span class="shrink-0 text-2xs text-subtle">{{ shapeOf(design) }}</span>
                    </span>
                    <span v-if="design.description" class="line-clamp-2 text-2xs text-subtle">{{ design.description }}</span>
                    <span v-if="pinned(design).length > 0" class="truncate text-2xs text-subtle">on {{ pinned(design).join(` · `) }}</span>
                </span>
            </button>
        </template>

        <!--
            The one door to the page that owns both kinds (and the long loop form). One row, not two, since the
            Workflows page is where both are authored.
        -->
        <button
            type="button"
            class="ui-row-select mt-0.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="emit(`manage`)"
        >
            <Icon :name="empty ? `plus` : `cog`" class="shrink-0 text-xs text-subtle" />
            <span :class="empty ? `text-sm text-content md:text-xs` : `text-2xs text-subtle`">{{
                empty ? `Set one up` : `Manage loops and workflows`
            }}</span>
        </button>
    </div>
</template>
