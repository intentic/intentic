<script setup lang="ts">
import { useToolCalls } from "../composables/chat/useToolCalls";

/* WHETHER A TRANSCRIPT SHOWS ITS TOOL CALLS: one control, wherever a transcript is read.
 *
 * It belongs beside the transcript because that is where the question is asked: you want the calls back at the
 * moment you are staring at a run mark wondering what it did, not two screens away in settings (where the same
 * preference also lives, for the person who wants it decided once). It is a component rather than markup in a
 * footer because there are TWO surfaces that draw a transcript and neither is the other's frame: the chat pane,
 * where it joins the readouts under the composer (ChatPaneStatus), and the Subagents area, where a child's
 * transcript has no composer at all and a bare strip along the same bottom edge carries it. Drawn twice from one definition,
 * so the glyph, its struck-through state and the words in its tooltip cannot drift between the two.
 *
 * A HAMMER, ALONE, AND STRUCK THROUGH WHEN THE CALLS ARE HIDDEN. The glyph names what is being shown: the work
 * a run did, not an eye's "visible/hidden", and at that it needs no label beside it; the word was the chip's
 * crutch back when the icon was a generic eye. Tilted off upright because a hammer mid-swing is a hammer, where
 * the straight-on one is a capital T at the size this draws at.
 *
 * State is the slash, NOT brightness: the strip is read at a glance and a control that lights up to say "on" is
 * a second bright thing competing with the numbers beside it. So the glyph stays at its host's own weight in
 * both states and only lifts under the pointer, and the crossed-out reading (the one every mute and hide
 * control in the world already uses) carries the answer. The slash runs across the handle, not along it.
 *
 * It INHERITS its host's ink rather than naming a colour, which is what lets one control sit in a status strip
 * set in `text-subtle` and on a footer strip set in `text-muted` without either reading as the odd one out. */

const { showToolCalls } = useToolCalls();
</script>

<template>
    <button
        type="button"
        class="touch-target relative inline-flex cursor-pointer items-center transition-colors hover:text-content"
        :aria-pressed="showToolCalls"
        :aria-label="showToolCalls ? 'Hide tool calls' : 'Show tool calls'"
        v-tooltip.top="showToolCalls ? 'Hide tool calls' : 'Show tool calls'"
        @click="showToolCalls = !showToolCalls"
    >
        <Icon name="hammer" class="rotate-[35deg] text-xs" />
        <span
            v-if="!showToolCalls"
            aria-hidden="true"
            class="pointer-events-none absolute top-1/2 left-1/2 h-px w-[130%] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current"
        />
    </button>
</template>
