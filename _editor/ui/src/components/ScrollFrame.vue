<!-- A bordered surface with a header that stays put and ONE body that scrolls: the note reader, the log viewer,
     the activity timeline. Header AND frame in one component, because there is no such thing here as one without
     the other: every caller of the header wrapped it in the frame, and shipping them separately meant three
     views hand-writing the shell and drifting apart on it.

     IT WAS CALLED `Panel`, AND THAT NAME COULD NEVER HAVE BEEN LEARNED. Thirteen files in this repo end in
     `Panel`: ChatPanel, TerminalPanel, ReviewPanel, AccountPanel, PickerPanel, and every one means "a region
     of the screen", which is not a word one component can hold. Vue Flow ships its own <Panel> too, which
     DagEditor imports two files away. Named for the contract now.

     ITS FOUR CALLERS ARE NOT A SHORTFALL, and the reason is worth writing down because it was mis-read once
     already. An audit counted 39 files in the web app carrying `min-h-0` and concluded they were 39 hand-rolled
     copies of this component. They are not: `min-h-0` is the general fix for a flex child that must be allowed
     to shrink, and it appears in rows, columns and skeletons that have nothing to do with a frame. Searched for
     what this actually IS (a bordered, rounded box with a header and one scrolling body) the web app contains
     ZERO hand-rolled copies. What it has instead are DOCKED PANES (the review panel, the history panel, the
     chat panel), which share this component's structure and deliberately none of its chrome: they fill a region
     the shell has already framed, so a border and a card background here would be a box inside a box. Reach for
     this where a panel draws its own edges; leave a docked pane alone.

     WHAT IT ACTUALLY OWNS IS THE SCROLL CONTRACT. `min-h-0` + `overflow-hidden` on the shell and `min-h-0
     flex-1 overflow-auto` on the body is the combination that makes a panel scroll ITSELF instead of growing
     until the page scrolls it: the single most re-discovered failure in this app. ActivityView and DocsView
     each carry a paragraph about the day they got it wrong; the hand-written copies had already drifted, one
     missing `overflow-hidden` entirely, so its rounded corners did not clip the rows underneath.

     THE HEADER STACKS BEFORE IT SQUEEZES. At rail width a title and a five-control cluster on one row leave the
     name reading as "Fix…", and the name is the whole point of a header, so below `md` the actions drop to
     their own line. That rule came from the note reader, the narrowest real instance and the one that found it.

     #meta is the fact line under the title (a path, a size, an edited-at): muted and small, so it can carry
     three facts without any of them competing with the name above.

     #strips is for what must interrupt between header and body without scrolling away: a destructive
     confirmation, an error banner. Shrink-0 by construction, which is what stops a long note from pushing
     "are you sure?" off screen.

     `grow` is the real variation between callers: a panel filling a flex row (a timeline beside a rail) takes
     `flex-1`; one sitting under a list (the log viewer) is sized by its content.

     `scroll: false` IS THE FRAME WITHOUT THE SCROLLER, for a body that is sized by its content on a
     page-scrolling surface (the activity feed in the sandbox hub) or that scrolls itself (an editor, a log
     tail). It clips with `overflow-clip` rather than `overflow-hidden`, and the difference is load-bearing:
     `hidden` makes this box a scroll container, so a `sticky` day header inside it resolves against a box that
     never scrolls and never sticks to anything. `clip` clips the corners just the same without becoming one,
     which leaves the page as the scrollport the header sticks to. -->
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
    <!-- A @container, because whether the header's title and actions fit on one line is a fact about the PANEL:
         these sit in a workspace pane the reader can drag down to a third of the window, where a viewport query
         says "wide" and hands a 300px header two competing halves. -->
    <section
        class="@container flex min-h-0 flex-col rounded-lg border border-line-subtle bg-card"
        :class="[grow ? `flex-1` : ``, scroll ? `overflow-hidden` : `overflow-clip`]"
    >
        <header
            v-if="title !== undefined || $slots[`title`] || $slots[`actions`] || $slots[`lead`]"
            class="flex shrink-0 flex-col gap-2 border-b border-line-subtle px-4 py-2.5 @xl:flex-row @xl:items-start @xl:justify-between @xl:gap-3"
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
