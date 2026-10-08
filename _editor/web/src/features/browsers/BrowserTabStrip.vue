<!-- The browser's tab strip, drawn the way every desktop browser draws one: the selected tab lifts out of the strip and
     runs into the toolbar under it, the others sit on the strip with a hairline between them, each shrinks as more
     open, and the + rides right after the last. Middle-click closes a tab and double-clicking the empty strip opens one,
     the two gestures a browser's own strip answers to. What a tab IS stays the caller's: this draws, it decides
     nothing. -->
<script setup lang="ts">
import type { BrowserPage } from "@intentic/sandbox-contract";
import { Icon, ui, vMiddleclick } from "@intentic/ui";
import { nextTick, ref, watch } from "vue";
import { useT } from "@intentic/ui/i18n";

const { pages, activeId, running } = defineProps<{
    pages: readonly BrowserPage[];
    activeId: string | undefined;
    // A closed browser's pages are a record: they can be looked through, not closed or added to.
    running: boolean;
    label: (page: BrowserPage) => string;
}>();

const emit = defineEmits<{ pick: [page: BrowserPage]; close: [page: BrowserPage]; open: [] }>();

const t = useT();

// Keeps the selected tab scrolled into view, so a crowded strip can't leave the page on screen off it when the agent
// switches pages. `scrollIntoView` is one-shot; nothing to clean up.
const stripEl = ref<HTMLElement | undefined>();
watch(
    () => activeId,
    async () => {
        await nextTick();
        stripEl.value?.querySelector(`[data-selected="true"]`)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
    },
    { immediate: true },
);

const close = (page: BrowserPage): void => {
    if (running) {
        emit(`close`, page);
    }
};

const open = (): void => {
    if (running) {
        emit(`open`);
    }
};
</script>

<template>
    <!-- The tabs scroll on their own once even their narrowest no longer fit, so the + after them never scrolls away. -->
    <div class="flex min-w-0 flex-1 items-end">
        <div ref="stripEl" role="tablist" class="scrollbar-none flex min-w-0 items-end overflow-x-auto overflow-y-hidden px-2">
            <!-- The tab and its close are siblings, not nested: a button cannot hold one. -->
            <div
                v-for="page in pages"
                :key="page.id"
                :data-selected="page.id === activeId"
                class="browser-tab group/tab @container relative flex h-8 w-60 min-w-14 shrink items-center"
                :class="page.id === activeId ? 'text-content' : 'text-muted hover:text-content'"
                v-middleclick="() => close(page)"
            >
                <button
                    type="button"
                    role="tab"
                    :aria-selected="page.id === activeId"
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded-t-lg pl-3 pr-1 text-left text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-500 @max-[4.5rem]:justify-center @max-[4.5rem]:px-0"
                    v-tooltip.bottom="{ title: label(page), note: page.url }"
                    @click="emit('pick', page)"
                >
                    <!-- Squeezed, a tab gives up what a browser's does: the selected one its globe and then its title, keeping its
                         close; the rest their title, keeping the globe that still tells them apart from empty strip. -->
                    <Icon name="globe" class="shrink-0 text-2xs" :class="page.id === activeId && running ? '@max-[5.5rem]:hidden' : ''" />
                    <span class="min-w-0 flex-1 truncate @max-[4.5rem]:hidden">{{ label(page) }}</span>
                </button>
                <button
                    v-if="running"
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
        </div>

        <button
            v-if="running"
            type="button"
            :class="ui.iconButton('h-7 w-7 self-center rounded-full')"
            :aria-label="t(`browsers.browsers.newTab`)"
            v-tooltip.bottom="t(`browsers.browsers.newTab`)"
            @click="open"
        >
            <Icon name="plus" class="text-xs" />
        </button>

        <!-- The empty run of strip past the last tab: where a double-click opens another, as in any browser. -->
        <div class="min-w-4 flex-1 self-stretch" @dblclick="open" />
    </div>
</template>

<style scoped>
/* PSEUDO-ELEMENTS AND SIBLING STATE, which no utility on the template can reach: the two concave feet that run the
   selected tab into the toolbar, and the hairline between tabs that steps aside for whichever one is selected or under
   the pointer, read off the NEXT tab's state through `:has()`. */
.browser-tab[data-selected="true"] {
    z-index: 1;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--color-card);
}

.browser-tab[data-selected="true"]::before,
.browser-tab[data-selected="true"]::after {
    content: "";
    position: absolute;
    bottom: 0;
    width: var(--radius-lg);
    height: var(--radius-lg);
    pointer-events: none;
}

.browser-tab[data-selected="true"]::before {
    left: calc(-1 * var(--radius-lg));
    background: radial-gradient(circle at 0 0, transparent calc(var(--radius-lg) - 0.5px), var(--color-card) var(--radius-lg));
}

.browser-tab[data-selected="true"]::after {
    right: calc(-1 * var(--radius-lg));
    background: radial-gradient(circle at 100% 0, transparent calc(var(--radius-lg) - 0.5px), var(--color-card) var(--radius-lg));
}

/* A tab under the pointer previews the selected one at half strength. */
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
</style>
