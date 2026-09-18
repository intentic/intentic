<script setup lang="ts">
import { Icon, ui } from "@intentic/extension-ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { anchorsOf, compareDocx } from "./docxCompare.js";
import { fitPages, keepFitted } from "./docxFit.js";
import { MARK_CLASS, type RedlineEvent } from "./docxRedline.js";
import { t } from "./i18n.js";

/* Two versions of a Word document as one: the new document as docx-preview draws it, with the words that left it
   struck through where they stood and the words that arrived underlined (docxRedline.ts). A bar over it counts what
   happened and steps through it; a strip down the right edge shows where, since a long document with one change is
   the common case. */

// `before` and `after` are the two versions' bytes; the host fetched both, this never reaches the daemon.
const { before, after } = defineProps<{ before: Blob; after: Blob; path: string }>();
// A pair nothing could draw as one: the host offers the other readings in this pane's place.
const emit = defineEmits<{ failed: [message: string] }>();

const host = ref<HTMLElement>();
const loading = ref(true);
const events = ref<readonly RedlineEvent[]>([]);
const whole = ref(false);
// Marked paragraphs by event, read off the rendered document; and where each event sits, as a share of the scroll.
let anchors = new Map<number, HTMLElement[]>();
const ticks = ref<readonly { readonly id: number; readonly kind: RedlineEvent["kind"]; readonly at: number }[]>([]);
// Which event is lit; -1 before the reader steps.
const current = ref(-1);

// Drops a stale render when the pair changes mid-parse.
let seq = 0;

const CURRENT_CLASS = `${MARK_CLASS}-current`;

const place = (): void => {
    const surface = host.value;
    if (surface === undefined || surface.scrollHeight === 0) {
        ticks.value = [];
        return;
    }
    const top = surface.getBoundingClientRect().top;
    ticks.value = events.value.flatMap((event) => {
        const first = anchors.get(event.id)?.[0];
        if (first === undefined) {
            return [];
        }
        return [{ id: event.id, kind: event.kind, at: (first.getBoundingClientRect().top - top + surface.scrollTop) / surface.scrollHeight }];
    });
};

const render = async (): Promise<void> => {
    const surface = host.value;
    if (surface === undefined) {
        return;
    }
    const id = ++seq;
    loading.value = true;
    current.value = -1;
    events.value = [];
    ticks.value = [];
    surface.replaceChildren();
    try {
        const compared = await compareDocx(before, after, surface, { removedPicture: t(`docxCompare.removedPicture`) });
        if (id !== seq) {
            return;
        }
        events.value = compared.events;
        whole.value = compared.whole;
        anchors = anchorsOf(surface);
        fitPages(surface);
        place();
    } catch (error) {
        if (id === seq) {
            emit(`failed`, error instanceof Error ? error.message : t(`docxCompare.couldNotCompare`));
        }
    } finally {
        if (id === seq) {
            loading.value = false;
        }
    }
};

// The pages are refitted and the ticks re-placed on every resize of the pane, since both are positions in a layout
// a resize reflows.
let unfit: (() => void) | undefined;
onMounted(() => {
    if (host.value !== undefined) {
        unfit = keepFitted(host.value, place);
    }
    void render();
});
onUnmounted(() => unfit?.());
watch(
    () => [before, after] as const,
    () => void render(),
);

// Lights one event's paragraphs and brings the first into view; wraps at both ends.
const go = (index: number): void => {
    const count = events.value.length;
    if (count === 0) {
        return;
    }
    const next = ((index % count) + count) % count;
    for (const element of anchors.get(events.value[current.value]?.id ?? -1) ?? []) {
        element.classList.remove(CURRENT_CLASS);
    }
    current.value = next;
    const lit = anchors.get(events.value[next]!.id) ?? [];
    for (const element of lit) {
        element.classList.add(CURRENT_CLASS);
    }
    lit[0]?.scrollIntoView({ block: `center`, behavior: `smooth` });
};

const counts = computed(() => ({
    changed: events.value.filter((event) => event.kind === `changed`).length,
    added: events.value.filter((event) => event.kind === `added`).length,
    removed: events.value.filter((event) => event.kind === `removed`).length,
}));
// "3 changed · 1 added · 2 removed", only the kinds that happened.
const kinds = computed(() =>
    (
        [
            [`changed`, counts.value.changed],
            [`added`, counts.value.added],
            [`removed`, counts.value.removed],
        ] as const
    )
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => t(`docxCompare.${kind}`, { count }, count))
        .join(` · `),
);

const TICK_CLASS: Record<RedlineEvent["kind"], string> = { changed: `bg-warning`, added: `bg-success`, removed: `bg-danger` };
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- The count first, since it is the one thing a reviewer wants before scrolling; the legend last, once. -->
        <div v-if="!loading" class="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1 text-2xs text-muted">
            <span class="tabular-nums text-content">{{ t(`docxCompare.changes`, { count: events.length }, events.length) }}</span>
            <span v-if="kinds" class="text-subtle">{{ kinds }}</span>
            <span v-if="events.length === 0" class="text-subtle">{{ t(`docxCompare.nothingMoved`) }}</span>
            <span v-else-if="whole" class="text-subtle">{{ t(`docxCompare.tooDifferent`) }}</span>
            <span class="flex-1"></span>
            <span class="flex items-center gap-2 text-subtle">
                <ins class="rounded-sm bg-success/15 px-1 text-content underline decoration-success underline-offset-2">{{ t(`docxCompare.legendAdded`) }}</ins>
                <del class="rounded-sm bg-danger/10 px-1 text-muted line-through decoration-danger">{{ t(`docxCompare.legendRemoved`) }}</del>
            </span>
            <template v-if="events.length > 0">
                <span class="tabular-nums text-subtle">{{ t(`docxCompare.position`, { current: current < 0 ? `–` : current + 1, count: events.length }) }}</span>
                <button type="button" :class="ui.iconButton()" :aria-label="t(`docxCompare.previousChange`)" v-tooltip.bottom="t(`docxCompare.previousChange`)" @click="go(current - 1)">
                    <Icon name="chevron-up" class="text-xs" />
                </button>
                <button type="button" :class="ui.iconButton()" :aria-label="t(`docxCompare.nextChange`)" v-tooltip.bottom="t(`docxCompare.nextChange`)" @click="go(current + 1)">
                    <Icon name="chevron-down" class="text-xs" />
                </button>
            </template>
        </div>
        <div class="relative min-h-0 flex-1">
            <div ref="host" class="docx-host h-full overflow-auto bg-muted/20"></div>
            <!-- Where each change sits down the whole document, one tick each, in the kind's colour; a press goes there. -->
            <div v-if="ticks.length > 0" class="pointer-events-none absolute inset-y-0 right-0 w-2.5">
                <button
                    v-for="(tick, index) in ticks"
                    :key="tick.id"
                    type="button"
                    class="pointer-events-auto absolute right-0 h-1 w-2.5 cursor-pointer rounded-l-sm opacity-80 hover:opacity-100"
                    :class="TICK_CLASS[tick.kind]"
                    :style="{ top: `${tick.at * 100}%` }"
                    :aria-label="t(`docxCompare.${tick.kind}`, { count: 1 }, 1)"
                    @click="go(index)"
                ></button>
            </div>
            <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-canvas text-muted">
                <Icon name="spinner" class="text-xl" spin />
            </div>
        </div>
    </div>
</template>

<style scoped>
/* docx-preview centers its own white "pages" in a wrapper; give the gutter a little breathing room. A page wider than
   the pane (fit stops at half size) starts at the left edge, where a scroll can reach it, rather than centred and cut. */
.docx-host :deep(.docx-wrapper) {
    padding: 1.5rem 0;
    background: transparent;
    align-items: safe center;
}
/* The marks are drawn on paper, which is white whatever the app's scheme, so their colours are the paper's. */
.docx-host :deep(ins) {
    text-decoration: underline;
    text-decoration-color: #1a7f37;
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
    background: rgb(46 160 67 / 0.16);
    border-radius: 2px;
}
.docx-host :deep(del) {
    text-decoration: line-through;
    text-decoration-color: #cf222e;
    color: #82071e;
    background: rgb(248 81 73 / 0.14);
    border-radius: 2px;
}
/* A marked paragraph carries a bar in the margin, so a change reads at page-scanning distance too. */
.docx-host :deep(p.docx-redline) {
    position: relative;
}
.docx-host :deep(p.docx-redline)::before {
    content: "";
    position: absolute;
    left: -14px;
    top: 0;
    bottom: 0;
    width: 3px;
    border-radius: 2px;
    background: #d4a72c;
}
.docx-host :deep(p.docx-redline-added)::before {
    background: #1a7f37;
}
.docx-host :deep(p.docx-redline-removed)::before {
    background: #cf222e;
}
.docx-host :deep(p.docx-redline-current) {
    outline: 2px solid #0969da;
    outline-offset: 4px;
    border-radius: 2px;
}
</style>
