<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { type LoopDesign, loopDesignLine } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { useLoopDesigns } from "../composables/agents/useLoopDesigns";

/* THE COMPOSER'S LOOP PICKER — "don't send this once, send it until it's actually done".
 *
 * IT REPLACED A MODAL, and what the modal got wrong is worth keeping written down. Pressing the loop pill used
 * to raise a centred dialog with six fields, the first of which asked for THE GOAL — a sentence the user had
 * almost always just typed into the message box behind it. So the one thing genuinely new each time was asked
 * twice, and the five things that are the same every time (end on `pnpm test`, fresh context, eight rounds,
 * five dollars, two idle) were asked from scratch every time. It also opened in the wrong WINDOW: a centred
 * dialog belongs to the app's document, and a popped-out chat is a document of its own, so pressing the pill
 * out there did nothing you could see.
 *
 * Both are the same fix. A loop is now a saved SHAPE picked from a menu that hangs off its own pill — so the
 * window question answers itself (the anchor decides, exactly as it does for persona and workflow), the goal
 * comes from the composer, and the machinery is authored once on the page that owns it.
 *
 * WHICH MAKES THIS THE WORKFLOW PICKER'S TWIN, deliberately down to the row shape. The two answer one question
 * — what is the next message run THROUGH — with different answers: a workflow spreads it across sessions that
 * are not this one, a loop repeats it in this one until a bar is cleared. Two controls that differ only in
 * their answer should not differ in how they are operated.
 */

const { picked } = defineProps<{ picked?: string }>();
const emit = defineEmits<{ picked: [design: LoopDesign | undefined]; manage: [] }>();

const { designs } = useLoopDesigns();
const empty = computed(() => designs.value.length === 0);
</script>

<template>
    <div class="flex flex-col p-1">
        <!-- Nothing saved is the ordinary state of a workspace that has never looped, not an error — so the
             sentence says what a loop IS (the message, repeated until a bar is cleared) rather than reporting an
             absence. Somebody reading this has just pressed a control whose name told them nothing. -->
        <p v-if="empty" class="px-2.5 py-3 text-2xs text-subtle">
            No loops saved yet. A loop sends your message over and over — fixing, checking, fixing — until something you can state is true.
        </p>
        <!-- The way back to an ordinary message, and it has to be a row: the pill is a badge like the workflow
             one, so unpicking belongs in the list the pick was made in. -->
        <button
            v-if="picked !== undefined"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="emit(`picked`, undefined)"
        >
            <Icon name="times" class="mt-0.5 shrink-0 text-xs text-subtle" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content md:text-xs">No loop</span>
                <span class="text-2xs text-subtle">Send once, as an ordinary message.</span>
            </span>
        </button>
        <button
            v-for="design in designs"
            :key="design.id"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            :class="{ 'ui-row-select-on': design.id === picked }"
            @click="emit(`picked`, design)"
        >
            <Icon name="repeat" class="mt-0.5 shrink-0 text-xs text-subtle" />
            <span class="flex min-w-0 flex-col">
                <span class="truncate text-sm text-content md:text-xs">{{ design.name }}</span>
                <!-- HOW IT ENDS AND HOW FAR IT MAY GO, on every row and computed from the loop itself. This is
                     the line that makes a picker safe to use without opening anything: a control that starts
                     paid work in a loop must say what stops it, at the moment of choosing. -->
                <span class="truncate text-2xs text-subtle">{{ loopDesignLine(design) }}</span>
                <span v-if="design.description" class="line-clamp-2 text-2xs text-subtle">{{ design.description }}</span>
            </span>
        </button>

        <!-- The way to the page that owns these, at the bottom where a list's "manage" always is — and the only
             door to the long form, which is now written once per loop instead of once per use. -->
        <button
            type="button"
            class="ui-row-select mt-0.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="emit(`manage`)"
        >
            <Icon :name="empty ? `plus` : `cog`" class="shrink-0 text-xs text-subtle" />
            <span :class="empty ? `text-sm text-content md:text-xs` : `text-2xs text-subtle`">{{ empty ? `Set up a loop` : `Manage loops` }}</span>
        </button>
    </div>
</template>
