<!--
    A bordered surface with a fixed header and one scrolling body. `#meta` is the muted fact line under the title; `#strips` holds banners that must
    not scroll away. `scroll: false` drops the internal scroller for content sized elsewhere; `sticky` pins the header to the page via
    `--pinned-top`.
-->
<script setup lang="ts">
import { computed } from "vue";

const {
    grow = false,
    scroll = true,
    sticky = false,
} = defineProps<{
    title?: string;
    description?: string;
    /** Fill the remaining space of a flex parent, rather than being sized by content. */
    grow?: boolean;
    /** Set false for a body that manages its own scrolling (an editor, an auto-scrolling log tail). */
    scroll?: boolean;
    /** Pin the header (and #strips) to the page scrollport, condensed to its title row. `scroll: false` only. */
    sticky?: boolean;
}>();

/* Ignored unless the page owns the scroll, so a caller cannot ask for a pin that has nothing to pin against.
 * `bg-card` is the frame's own surface repeated on the header: a stuck header scrolls prose under itself and
 * needs to be opaque, and inheriting the section's background is not the same thing as painting it. */
const pinned = computed(() => sticky && !scroll);
</script>

<template>
    <!-- A @container, because whether the header's title and actions fit on one line is a fact about the PANEL:
         these sit in a workspace pane the reader can drag down to a third of the window, where a viewport query
         says "wide" and hands a 300px header two competing halves. -->
    <section
        class="@container flex min-h-0 flex-col rounded-lg border border-line-subtle bg-card"
        :class="[grow ? `flex-1` : ``, scroll ? `overflow-hidden` : `overflow-clip`]"
    >
        <!-- THE HEAD AND THE STRIPS PIN AS ONE BLOCK when pinned, rather than as two stacked `sticky` elements
             at hand-computed offsets. The header's height is not a constant here (a title wraps, an action
             cluster drops to its own row below `@xl`), so any `top-<n>` on the strips is a number that is wrong
             at some width, and wrong here means a delete confirmation hidden behind the bar that asked it. -->
        <div :class="pinned ? `sticky top-(--pinned-top) z-2 shrink-0 bg-card` : `contents`">
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
                    <!-- Pinned, these two are NOT in the bar: see the note above. They fall through to the top of
                         the document instead, which is where they are read. -->
                    <template v-if="!pinned">
                        <p v-if="description !== undefined || $slots[`description`]" class="mt-1 text-xs text-muted">
                            <slot name="description">{{ description }}</slot>
                        </p>
                        <p v-if="$slots[`meta`]" class="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-subtle"><slot name="meta" /></p>
                    </template>
                </div>
                <div v-if="$slots[`actions`]" class="flex shrink-0 items-center gap-1.5"><slot name="actions" /></div>
            </header>

            <div v-if="$slots[`strips`]" class="shrink-0"><slot name="strips" /></div>
        </div>

        <!-- The facts the pinned bar handed back, at the head of the document rather than in the chrome. -->
        <div
            v-if="pinned && (description !== undefined || $slots[`description`] || $slots[`meta`])"
            class="flex shrink-0 flex-col gap-1 border-b border-line-subtle px-4 py-2.5"
        >
            <p v-if="description !== undefined || $slots[`description`]" class="text-xs text-muted">
                <slot name="description">{{ description }}</slot>
            </p>
            <p v-if="$slots[`meta`]" class="flex flex-wrap items-center gap-x-1.5 text-2xs text-subtle"><slot name="meta" /></p>
        </div>

        <div v-if="scroll" class="scrollbar-thin min-h-0 flex-1 overflow-auto"><slot /></div>
        <slot v-else />
    </section>
</template>
