<!-- A bordered surface with a header that stays put and ONE body that scrolls — the note reader, the log viewer,
     the activity timeline. Header AND frame in one component, because there is no such thing here as one without
     the other: every caller of the header wrapped it in the frame, and shipping them separately meant three
     views hand-writing the shell and drifting apart on it.

     WHAT IT ACTUALLY OWNS IS THE SCROLL CONTRACT. `min-h-0` + `overflow-hidden` on the shell and `min-h-0
     flex-1 overflow-auto` on the body is the combination that makes a panel scroll ITSELF instead of growing
     until the page scrolls it — the single most re-discovered failure in this app. ActivityView and DocsView
     each carry a paragraph about the day they got it wrong; the hand-written copies had already drifted, one
     missing `overflow-hidden` entirely, so its rounded corners did not clip the rows underneath.

     THE HEADER STACKS BEFORE IT SQUEEZES. At rail width a title and a five-control cluster on one row leave the
     name reading as "Fix…", and the name is the whole point of a header — so below `md` the actions drop to
     their own line. That rule came from the note reader, the narrowest real instance and the one that found it.

     #meta is the fact line under the title (a path, a size, an edited-at): muted and small, so it can carry
     three facts without any of them competing with the name above.

     #strips is for what must interrupt between header and body without scrolling away — a destructive
     confirmation, an error banner. Shrink-0 by construction, which is what stops a long note from pushing
     "are you sure?" off screen.

     `grow` is the real variation between callers: a panel filling a flex row (a timeline beside a rail) takes
     `flex-1`; one sitting under a list (the log viewer) is sized by its content. -->
<script setup lang="ts">
const { grow = false, scroll = true } = defineProps<{
    title?: string;
    description?: string;
    /** Fill the remaining space of a flex parent, rather than being sized by content. */
    grow?: boolean;
    /** Set false for a body that manages its own scrolling (an editor, an auto-scrolling log tail). */
    scroll?: boolean;
}>();
</script>

<template>
    <section class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-card" :class="grow ? `flex-1` : ``">
        <header
            v-if="title !== undefined || $slots[`title`] || $slots[`actions`] || $slots[`lead`]"
            class="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-2.5 md:flex-row md:items-start md:justify-between md:gap-3"
        >
            <div class="min-w-0">
                <div class="flex min-w-0 items-center gap-2">
                    <slot name="lead" />
                    <h2 v-if="title !== undefined || $slots[`title`]" class="min-w-0 truncate text-sm font-medium text-content">
                        <slot name="title">{{ title }}</slot>
                    </h2>
                    <slot name="badges" />
                </div>
                <p v-if="description !== undefined || $slots[`description`]" class="mt-1 text-xs text-muted">
                    <slot name="description">{{ description }}</slot>
                </p>
                <p v-if="$slots[`meta`]" class="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-subtle"><slot name="meta" /></p>
            </div>
            <div v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-1.5"><slot name="actions" /></div>
        </header>

        <div v-if="$slots[`strips`]" class="shrink-0"><slot name="strips" /></div>
        <div v-if="scroll" class="scrollbar-thin min-h-0 flex-1 overflow-auto"><slot /></div>
        <slot v-else />
    </section>
</template>
