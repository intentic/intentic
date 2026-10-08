<!-- The browser's tab strip, drawn the way every desktop browser draws one: the selected tab lifts out of the strip and
     runs into the toolbar under it, the others sit on the strip with a hairline between them, each shrinks as more
     open, and the + rides right after the last, always there. The lifted shape is one piece that slides from tab to tab
     rather than a background that jumps, and a tab grows in as it opens and folds away as it closes. Middle-click closes
     a tab and double-clicking the empty strip opens one, the two gestures a browser's own strip answers to. What a tab
     IS stays the caller's: this draws, it decides nothing. -->
<script setup lang="ts">
import type { BrowserPage } from "@intentic/sandbox-contract";
import { Icon, ui, vMiddleclick } from "@intentic/ui";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useT } from "@intentic/ui/i18n";

const { pages, activeId, closable } = defineProps<{
    pages: readonly BrowserPage[];
    activeId: string | undefined;
    // Whether a tab may be closed from here: not while an agent is driving the window, nor on a page that isn't a real
    // tab yet (the start page's).
    closable: boolean;
    label: (page: BrowserPage) => string;
}>();

const emit = defineEmits<{ pick: [page: BrowserPage]; close: [page: BrowserPage]; open: [] }>();

const t = useT();

const stripEl = ref<HTMLElement | undefined>();

// The lifted shape under the selected tab: where it sits, read off the tab itself, and whether moving it animates. Not
// on its first placement, which would otherwise slide in from the strip's left edge as the view opens.
const indicator = ref<{ left: number; width: number } | undefined>();
const gliding = ref(false);

// A tab on its way out still carries the mark it had; the shape goes to the one staying.
const SELECTED = `.browser-tab[data-selected="true"]:not(.tab-leave-active)`;

const measure = (): void => {
    const tab = stripEl.value?.querySelector<HTMLElement>(SELECTED);
    indicator.value = tab === null || tab === undefined ? undefined : { left: tab.offsetLeft, width: tab.offsetWidth };
};

// Tabs growing in or folding away move every tab beside them for as long as the fold lasts, so the shape is re-read
// every frame of it rather than once at the start.
const FOLLOW_MS = 320;
let frame = 0;
let followUntil = 0;
const tick = (): void => {
    measure();
    frame = performance.now() < followUntil ? requestAnimationFrame(tick) : 0;
};
const follow = (): void => {
    followUntil = performance.now() + FOLLOW_MS;
    if (frame === 0) {
        tick();
    }
};

watch(
    () => [activeId, pages.map((page) => page.id).join(` `)],
    async () => {
        await nextTick();
        follow();
        // Keeps the selected tab in view, so a crowded strip can't leave the page on screen off it.
        stripEl.value?.querySelector(SELECTED)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
    },
);

let resize: ResizeObserver | undefined;
onMounted(() => {
    measure();
    resize = new ResizeObserver(measure);
    if (stripEl.value !== undefined) {
        resize.observe(stripEl.value);
    }
    // The first placement has painted; from here on the shape glides.
    requestAnimationFrame(() => (gliding.value = true));
});
onBeforeUnmount(() => {
    resize?.disconnect();
    cancelAnimationFrame(frame);
});

const close = (page: BrowserPage): void => {
    if (closable) {
        emit(`close`, page);
    }
};
</script>

<template>
    <!-- The tabs scroll on their own once even their narrowest no longer fit, so the + after them never scrolls away. -->
    <div class="flex min-w-0 flex-1 items-end">
        <div ref="stripEl" role="tablist" class="scrollbar-none relative flex min-w-0 items-end overflow-x-auto overflow-y-hidden px-2">
            <div
                v-if="indicator"
                class="tab-lift pointer-events-none absolute bottom-0 left-0 h-8"
                :class="gliding ? 'tab-lift-glide' : ''"
                :style="{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }"
                aria-hidden="true"
            />
            <TransitionGroup name="tab">
                <!-- The tab and its close are siblings, not nested: a button cannot hold one. -->
                <div
                    v-for="page in pages"
                    :key="page.id"
                    :data-selected="page.id === activeId"
                    class="browser-tab group/tab @container relative flex h-8 w-60 min-w-14 shrink items-center transition-colors"
                    :class="page.id === activeId ? 'text-content' : 'text-muted hover:text-content'"
                    v-middleclick="() => close(page)"
                >
                    <button
                        type="button"
                        role="tab"
                        :aria-selected="page.id === activeId"
                        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded-t-lg pl-3 pr-1 text-left text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 @max-[4.5rem]:justify-center @max-[4.5rem]:px-0"
                        v-tooltip.bottom="page.url === `` ? undefined : { title: label(page), note: page.url }"
                        @click="emit('pick', page)"
                    >
                        <!-- Squeezed, a tab gives up what a browser's does: the selected one its globe and then its title, keeping its
                             close; the rest their title, keeping the globe that still tells them apart from empty strip. -->
                        <Icon name="globe" class="shrink-0 text-2xs" :class="page.id === activeId && closable ? '@max-[5.5rem]:hidden' : ''" />
                        <span class="min-w-0 flex-1 truncate @max-[4.5rem]:hidden">{{ label(page) }}</span>
                    </button>
                    <button
                        v-if="closable"
                        type="button"
                        :class="
                            ui.iconButton(
                                'mr-1.5 h-5 w-5 rounded-full focus-visible:opacity-100',
                                page.id === activeId ? '' : 'opacity-0 group-hover/tab:opacity-100 @max-[5.5rem]:hidden',
                            )
                        "
                        :aria-label="t(`browsers.browsers.closeTab`)"
                        v-tooltip.bottom="t(`browsers.browsers.closeTab`)"
                        @click="close(page)"
                    >
                        <Icon name="times" class="text-3xs" />
                    </button>
                    <span class="tab-rule" aria-hidden="true" />
                </div>
            </TransitionGroup>
        </div>

        <!-- Always here: a browser never hides the way to a new tab, whatever the window in front is doing. -->
        <button
            type="button"
            :class="ui.iconButton('h-7 w-7 self-center rounded-full')"
            :aria-label="t(`browsers.browsers.newTab`)"
            v-tooltip.bottom="t(`browsers.browsers.newTab`)"
            @click="emit('open')"
        >
            <Icon name="plus" class="text-xs" />
        </button>

        <!-- The empty run of strip past the last tab: where a double-click opens another, as in any browser. -->
        <div class="min-w-4 flex-1 self-stretch" @dblclick="emit('open')" />

        <!-- The strip's far end, where a browser keeps its list of everything open. -->
        <slot name="end" />
    </div>
</template>

<style scoped>
/* PSEUDO-ELEMENTS, SIBLING STATE AND TRANSITION CLASSES, which no utility on the template can reach: the lifted shape
   and its two concave feet that run the selected tab into the toolbar, the hairline between tabs that steps aside for
   whichever one is selected or under the pointer (read off the NEXT tab through `:has()`), and the classes Vue's
   TransitionGroup puts on a tab as it grows in and folds away. */
.tab-lift {
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--color-card);
}

.tab-lift-glide {
    transition:
        transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
        width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.tab-lift::before,
.tab-lift::after {
    content: "";
    position: absolute;
    bottom: 0;
    width: var(--radius-lg);
    height: var(--radius-lg);
}

.tab-lift::before {
    left: calc(-1 * var(--radius-lg));
    background: radial-gradient(circle at 0 0, transparent calc(var(--radius-lg) - 0.5px), var(--color-card) var(--radius-lg));
}

.tab-lift::after {
    right: calc(-1 * var(--radius-lg));
    background: radial-gradient(circle at 100% 0, transparent calc(var(--radius-lg) - 0.5px), var(--color-card) var(--radius-lg));
}

.browser-tab {
    max-width: 15rem;
}

/* A tab under the pointer previews the lifted one at half strength. */
.browser-tab:not([data-selected="true"]):hover {
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: color-mix(in srgb, var(--color-card) 55%, transparent);
}

.tab-rule {
    position: absolute;
    top: 0.5rem;
    right: 0;
    bottom: 0.5rem;
    width: 1px;
    background: var(--color-line);
}

.browser-tab:is([data-selected="true"], :hover) .tab-rule,
.browser-tab:has(+ .browser-tab:is([data-selected="true"], :hover)) .tab-rule,
.browser-tab:not(:has(+ .browser-tab)) .tab-rule {
    display: none;
}

.tab-enter-active,
.tab-leave-active {
    overflow: hidden;
    transition:
        max-width 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
        min-width 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
        opacity 160ms ease;
}

.tab-enter-from,
.tab-leave-to {
    min-width: 0;
    max-width: 0;
    opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
    .tab-lift-glide,
    .tab-enter-active,
    .tab-leave-active {
        transition: none;
    }
}
</style>
