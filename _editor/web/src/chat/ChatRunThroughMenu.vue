<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { type LoopDesign, type Workflow, loopDesignLine } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { useLoopDesigns } from "../composables/agents/useLoopDesigns";
import { useWorkflowRuns } from "../composables/agents/useWorkflowRuns";

/* THE COMPOSER'S "RUN THROUGH" PICKER: the one answer to "what happens to this message when I press send".
 *
 * IT USED TO BE TWO PILLS AND TWO MENUS, and the split is worth keeping written down because it looked
 * principled and wasn't. A loop and a workflow are different machines: one repeats this message in this chat
 * until a bar is cleared, the other fans it across sessions that are not this one, but they are answers to the
 * SAME question, and the composer can only take one of them. The old row said so in the weakest way available:
 * arming a workflow greyed the loop pill out. So the exclusivity was a thing you discovered by watching a
 * neighbour dim, two bare glyphs sat side by side with nothing to tell them apart until you hovered one, and
 * "where do I find the shape I saved" had two places to look before it had an answer.
 *
 * One control, one list, two headed sections. The exclusivity stops being a rule that greys something out and
 * becomes the shape of the thing: picking is picking, and a pick replaces a pick. The headings do the teaching
 * the two glyphs never could: you read what the difference IS at the moment you are choosing between them,
 * which is the only moment it matters.
 *
 * WHAT DOESN'T COLLAPSE is the sentence under each row. A loop row still carries its stop condition and its
 * ceilings, because it is the one pick here that goes on spending after the user has looked away; a workflow
 * row still carries its shape and the models it pins, because that is why anyone keeps one. Merging the
 * controls was never a licence to merge what they have to say.
 */

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

// Which providers a design pins, named once each. The one fact worth carrying into a picker row: a design that
// runs two different models is the reason somebody keeps a workflow at all, and it is invisible in a name.
const pinned = (design: Workflow): string[] => [...new Set(design.steps.flatMap((step) => (step.agent === undefined ? [] : [step.agent])))];

const picked = computed(() => loop !== undefined || workflow !== undefined);
const empty = computed(() => loops.value.length === 0 && workflows.value.length === 0);
</script>

<template>
    <div class="flex flex-col p-1">
        <!-- Nothing saved anywhere is the ordinary state of a workspace that has never needed either, not an
             error, so the sentence says what the two things ARE rather than reporting an absence twice.
             Somebody reading this has just pressed a control whose glyph told them nothing. -->
        <p v-if="empty" class="px-2.5 py-3 text-2xs text-subtle">
            Nothing saved yet. A <strong class="font-medium text-muted">loop</strong> sends your message over and over: fixing, checking, fixing:
            until something you can state is true. A <strong class="font-medium text-muted">workflow</strong> hands it to a design of several sessions
            instead of to this chat.
        </p>

        <!-- The way back to an ordinary message, and it has to be a row: the pill is a badge, so unpicking
             belongs in the list the pick was made in. ONE row for both kinds, which is the whole point of the
             merge, since "no loop" and "no workflow" were never two states a person could be in at once. -->
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

        <!-- THE TWO SECTIONS ARE HEADED, and the heading is the sentence that separates them rather than a
             label. This is where the difference between the machines gets taught: at the moment of choosing,
             which is the only moment anyone cares, and it is what the two bare glyphs in the old row could
             never say. Each heading hides with its section: a workspace with loops and no workflows reads as a
             loop picker, not as a half-empty pair. -->
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
                    <!-- HOW IT ENDS AND HOW FAR IT MAY GO, on every row and computed from the loop itself. This
                         is the line that makes a picker safe to use without opening anything: a control that
                         starts paid work in a loop must say what stops it, at the moment of choosing. -->
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

        <!-- The way to the page that owns BOTH kinds, at the bottom where a list's "manage" always is, and the
             only door to the long loop form, which is written once per loop instead of once per use. One row
             rather than two because the Workflows page is where both are authored; sending someone to "manage
             loops" and "manage workflows" separately would invent a split the app doesn't have. -->
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
