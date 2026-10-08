<!-- The browser's tab strip, drawn the way every desktop browser draws one: the selected tab lifts out of the strip and
     runs into the toolbar under it, the others sit on the strip with a hairline between them, each shrinks as more
     open, and the + rides right after the last, always there. The lifted shape is one piece that slides from tab to tab
     rather than a background that jumps, and a tab grows in as it opens and folds away as it closes. Middle-click closes
     a tab and double-clicking the empty strip opens one, the two gestures a browser's own strip answers to. Pinned tabs
     (a live app, the desktop, a window on it) lead, set off from the web pages by a hairline. When the web pages come
     from more than one window, each window's run of tabs opens with its label, as a browser's tab groups do. What a tab
     IS stays the caller's: this draws, it decides nothing. -->
<script setup lang="ts">
import { Icon, ui, vMiddleclick } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useT } from "@intentic/ui/i18n";
import { stripItems, type StripGroup, type StripTab } from "./stripTab";

const { tabs, activeId } = defineProps<{
    tabs: readonly StripTab[];
    activeId: string | undefined;
}>();

// `quickOpen` is a web tab straight away, what a browser's + and a double-click on its strip both do; `open` is the
// launcher's chevron beside the +, handed its own button so a menu can hang off it. `pickGroup` is a window's label,
// which puts that window in front.
const emit = defineEmits<{
    pick: [tab: StripTab];
    close: [tab: StripTab];
    pickGroup: [group: StripGroup];
    open: [anchor: HTMLElement];
    quickOpen: [];
}>();

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

// Keeps the selected tab in view, so a crowded strip can't leave the page on screen off it: as tabs come and go, and as
// the strip narrows under them.
const reveal = (): void => stripEl.value?.querySelector(SELECTED)?.scrollIntoView({ block: `nearest`, inline: `nearest` });

watch(
    () => [activeId, tabs.map((tab) => tab.id).join(` `)],
    async () => {
        await nextTick();
        follow();
        reveal();
    },
);

let resize: ResizeObserver | undefined;
onMounted(() => {
    measure();
    resize = new ResizeObserver(() => {
        measure();
        reveal();
    });
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

const close = (tab: StripTab): void => {
    if (tab.closable) {
        emit(`close`, tab);
    }
};

const items = computed(() => stripItems(tabs));
</script>

<template>
    <!-- The tabs scroll on their own once even their narrowest no longer fit, so the + after them never scrolls away. -->
    <div class="@container/strip flex min-w-0 flex-1 items-end">
        <div ref="stripEl" role="tablist" class="scrollbar-none relative flex min-w-0 items-end overflow-x-auto overflow-y-hidden px-2">
            <div
                v-if="indicator"
                class="tab-lift pointer-events-none absolute bottom-0 left-0 h-8"
                :class="gliding ? 'tab-lift-glide' : ''"
                :style="{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }"
                aria-hidden="true"
            />
            <TransitionGroup name="tab">
                <template v-for="item in items" :key="item.key">
                    <!-- A window's label: whose tabs follow, and the one press that puts that window in front. Squeezed, it
                         keeps enough of its name to tell one window from the next, which is what it is for; on a strip
                         too narrow to spare that (a side panel), its dot, with the name on hover. -->
                    <button
                        v-if="item.kind === `label`"
                        type="button"
                        :data-seam="item.seam"
                        class="browser-group relative flex h-8 min-w-20 max-w-40 shrink cursor-pointer @max-[36rem]/strip:min-w-6 items-center px-0.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500"
                        :aria-label="item.group.note === undefined ? item.group.label : `${item.group.label}, ${item.group.note}`"
                        v-tooltip.bottom="{ title: item.group.label, note: item.group.note }"
                        @click="emit('pickGroup', item.group)"
                    >
                        <span
                            class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-2xs font-medium transition-colors"
                            :class="
                                item.group.current ? 'bg-content/10 text-content' : 'bg-content/5 text-muted hover:bg-content/10 hover:text-content'
                            "
                        >
                            <span class="size-1.5 shrink-0 rounded-full" :class="item.group.dot" />
                            <span class="min-w-0 truncate">{{ item.group.label }}</span>
                        </span>
                    </button>
                    <!-- The tab and its close are siblings, not nested: a button cannot hold one. -->
                    <div
                        v-else
                        :data-selected="item.tab.id === activeId"
                        :data-seam="item.seam"
                        class="browser-tab group/tab @container relative flex h-8 w-60 min-w-14 shrink items-center transition-colors"
                        :class="item.tab.id === activeId ? 'text-content' : 'text-muted hover:text-content'"
                        v-middleclick="() => close(item.tab)"
                    >
                        <button
                            type="button"
                            role="tab"
                            :aria-selected="item.tab.id === activeId"
                            class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded-t-lg pl-3 pr-1 text-left text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 @max-[4.5rem]:justify-center @max-[4.5rem]:px-0"
                            v-tooltip.bottom="
                                item.tab.note === undefined || item.tab.note === `` ? undefined : { title: item.tab.label, note: item.tab.note }
                            "
                            @click="emit('pick', item.tab)"
                        >
                            <!-- Squeezed, a tab gives up what a browser's does: the selected one its glyph and then its title, keeping
                                 its close; the rest their title, keeping the glyph that still says what each is. -->
                            <Icon
                                :name="item.tab.icon"
                                :spin="item.tab.spin === true"
                                class="shrink-0 text-2xs"
                                :class="[item.tab.tint, item.tab.id === activeId && item.tab.closable ? '@max-[5.5rem]:hidden' : '']"
                            />
                            <span class="min-w-0 flex-1 truncate @max-[4.5rem]:hidden">{{ item.tab.label }}</span>
                            <span v-if="item.tab.kind" class="sr-only">, {{ item.tab.kind }}</span>
                        </button>
                        <button
                            v-if="item.tab.closable"
                            type="button"
                            :class="
                                ui.iconButton(
                                    { size: `xs`, round: true },
                                    `mr-1.5 focus-visible:opacity-100`,
                                    item.tab.id === activeId ? `` : `opacity-0 group-hover/tab:opacity-100 @max-[5.5rem]:hidden`,
                                )
                            "
                            :aria-label="t(`browsers.browsers.closeTab`)"
                            v-tooltip.bottom="t(`browsers.browsers.closeTab`)"
                            @click="close(item.tab)"
                        >
                            <Icon name="times" class="text-3xs" />
                        </button>
                        <span class="tab-rule" aria-hidden="true" />
                    </div>
                </template>
            </TransitionGroup>
        </div>

        <!-- Always here: a browser never hides the way to a new tab, whatever the window in front is doing. One press
             is a web tab, as in every browser; the chevron beside it is the launcher, with everything else this view
             can show (the apps, the desktop). It was the + itself once, which made the commonest press a menu. -->
        <button
            type="button"
            :class="ui.iconButton({ size: `md`, round: true }, 'self-center')"
            :aria-label="t(`browsers.browsers.newTab`)"
            v-tooltip.bottom="t(`browsers.browsers.newTab`)"
            @click="emit('quickOpen')"
        >
            <Icon name="plus" class="text-xs" />
        </button>
        <button
            type="button"
            :class="ui.iconButton({ size: `xs`, round: true }, `-ml-1 self-center`)"
            aria-haspopup="menu"
            :aria-label="t(`browsers.launcher.more`)"
            v-tooltip.bottom="t(`browsers.launcher.more`)"
            @click="emit('open', $event.currentTarget as HTMLElement)"
        >
            <Icon name="chevron-down" class="text-3xs" />
        </button>

        <!-- The empty run of strip past the last tab: where a double-click opens another, as in any browser. -->
        <div class="min-w-4 flex-1 self-stretch" @dblclick="emit('quickOpen')" />

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

/* The seam between two runs (the pins and the web pages, one window's pages and the next's): a full-height hairline on
   the leading edge of whatever starts the new run, kept even while a neighbour is selected, since it marks a group
   rather than a gap between two tabs. */
:is(.browser-tab, .browser-group)[data-seam="true"] {
    margin-left: 0.5rem;
}

:is(.browser-tab, .browser-group)[data-seam="true"]::before {
    content: "";
    position: absolute;
    top: 0.375rem;
    bottom: 0.375rem;
    left: -0.3125rem;
    width: 1px;
    background: var(--color-line-strong);
}

.tab-rule {
    position: absolute;
    top: 0.5rem;
    right: 0;
    bottom: 0.5rem;
    width: 1px;
    background: var(--color-line);
}

/* The hairline after a tab steps aside for the selected tab and the one under the pointer, on either side of it, and
   after the last tab of a run, where a seam or the + follows. */
.browser-tab:is([data-selected="true"], :hover) .tab-rule,
.browser-tab:has(+ .browser-tab:is([data-selected="true"], :hover)) .tab-rule,
.browser-tab:not(:has(+ .browser-tab)) .tab-rule,
.browser-tab:has(+ [data-seam="true"]) .tab-rule {
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

:root[data-motion="reduced"] :is(.tab-lift-glide, .tab-enter-active, .tab-leave-active) {
    transition: none;
}
</style>
