<!-- A bordered surface with a header that stays put and ONE body that scrolls — the note reader, the log viewer,
     the activity timeline. <PanelHeader> is what goes in its #header; this is the frame that header sits in, and
     shipping one without the other is what left three callers writing the frame by hand.

     WHAT IT ACTUALLY OWNS IS THE SCROLL CONTRACT. `min-h-0` + `overflow-hidden` on the shell and `min-h-0
     flex-1 overflow-auto` on the body is the combination that makes a panel scroll ITSELF instead of growing
     until the page scrolls it — and it is the single most re-discovered failure in this app. ActivityView and
     DocsView each carry a paragraph about the day they got it wrong; the three hand-written copies of this
     shell had already drifted apart on it, one of them missing `overflow-hidden` entirely, so its rounded
     corners did not clip the rows underneath them.

     `grow` is the only real variation between the callers: a panel that fills a flex row (a timeline beside a
     rail) takes `flex-1`, one that sits under a list (the log viewer) is sized by its content.

     #strips is for the things that must interrupt between the header and the body without scrolling away — a
     destructive confirmation, an error banner. They are shrink-0 by construction, which is what stops a long
     note from pushing "are you sure?" off screen. -->
<script setup lang="ts">
const { grow = false, scroll = true } = defineProps<{
    /** Fill the remaining space of a flex parent, rather than being sized by content. */
    grow?: boolean;
    /** Set false for a body that manages its own scrolling (an editor, a virtualised list). */
    scroll?: boolean;
}>();
</script>

<template>
    <section class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-card" :class="grow ? `flex-1` : ``">
        <slot name="header" />
        <div v-if="$slots[`strips`]" class="shrink-0"><slot name="strips" /></div>
        <div v-if="scroll" class="scrollbar-thin min-h-0 flex-1 overflow-auto"><slot /></div>
        <slot v-else />
    </section>
</template>
