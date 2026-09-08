import { onBeforeUnmount, ref, watch, type Ref } from "vue";

// Reader's position and jump targets for the outline rail (MarkdownOutline.vue), read off the rendered DOM (h1-h4)
// rather than the source, the real scroll target. The DOM is replaced without warning; nothing here holds a node
// between frames, a MutationObserver remeasures into plain offset numbers instead.

export interface OutlineHeading {
    // 1-4, matching the levels prose.css styles; drawn as indentation, never as a number.
    readonly level: number;
    readonly text: string;
}

const HEADINGS = `h1, h2, h3, h4`;

// Pixels below the scroll top marking where a section becomes current, not the top edge itself.
const ACTIVE_LINE = 72;

// Pixels a jumped heading lands below the top edge; must stay under ACTIVE_LINE or a jump won't mark its row.
const JUMP_INSET = 16;

// Scroll positions this close count as equal since scrollTop is fractional and never hits the bottom exactly.
const END_SLACK = 2;

/** Heading index the reader is inside, given each heading's scroll-box offset; -1 if none. */
export const activeAt = (tops: readonly number[], scrollTop: number, atEnd: boolean): number => {
    if (tops.length === 0) {
        return -1;
    }
    // A last section too short to scroll to top would never become active otherwise; at the bottom it always is.
    if (atEnd) {
        return tops.length - 1;
    }
    let active = 0;
    for (const [index, top] of tops.entries()) {
        if (top > scrollTop + ACTIVE_LINE) {
            break;
        }
        active = index;
    }
    return active;
};

/** How far through the document the reader is, 0-1; a document that fits its pane is fully read. */
export const progressAt = (scrollTop: number, scrollHeight: number, clientHeight: number): number => {
    const travel = scrollHeight - clientHeight;
    return travel <= 0 ? 1 : Math.min(1, Math.max(0, scrollTop / travel));
};

/** The headings a filter query leaves, each carrying the index it has in the document. */
export const matchHeadings = (headings: readonly OutlineHeading[], query: string): { heading: OutlineHeading; index: number }[] => {
    const needle = query.trim().toLowerCase();
    const all = headings.map((heading, index) => ({ heading, index }));
    return needle === `` ? all : all.filter((row) => row.heading.text.toLowerCase().includes(needle));
};

// A heading's own words as a single line, collapsing inline markup and source line-wraps.
const headingText = (node: Element): string => (node.textContent ?? ``).replaceAll(/\s+/gu, ` `).trim();

// Heading elements in document order. One with no text (a bare `#`, or streamed-in content not arrived yet) is skipped.
const headingNodes = (view: ParentNode): HTMLElement[] =>
    [...view.querySelectorAll<HTMLElement>(HEADINGS)].filter((node) => headingText(node) !== ``);

const toHeading = (node: Element): OutlineHeading => ({ level: Number(node.tagName.slice(1)), text: headingText(node) });

/** Every heading the prose is showing, in document order. */
export const readHeadings = (view: ParentNode): OutlineHeading[] => headingNodes(view).map(toHeading);

// Whether a re-measure found the same headings, so the rail isn't rebuilt and doesn't lose hover, focus or filter
// state.
const sameHeadings = (a: readonly OutlineHeading[], b: readonly OutlineHeading[]): boolean =>
    a.length === b.length && a.every((heading, index) => heading.level === b[index]?.level && heading.text === b[index]?.text);

export interface MarkdownOutline {
    /** Every heading in the rendered document, in order. */
    readonly headings: Ref<OutlineHeading[]>;
    /** Index into `headings` of the section the reader is in; -1 when the document has none. */
    readonly active: Ref<number>;
    /** Scroll position through the document, 0-1. */
    readonly progress: Ref<number>;
    /** Whether the document is longer than its pane; false means `progress` has nothing to report. */
    readonly scrollable: Ref<boolean>;
    // Rail's own inset: scrollbar strip width in px; 0 with overlay scrollbars, ~11px otherwise.
    readonly gutter: Ref<number>;
    /** Scroll heading `index` into view. */
    readonly jump: (index: number) => void;
}

/**
 * Track the headings inside `scroller` and where the reader is among them.
 *
 * @param scroller Scroll container for the prose; can be `null` (Vue on unmount) as well as `undefined` (ref not yet
 * bound), so read it through `element()`.
 */
export const useMarkdownOutline = (scroller: Readonly<Ref<HTMLElement | null | undefined>>): MarkdownOutline => {
    const headings = ref<OutlineHeading[]>([]);
    const active = ref(-1);
    const progress = ref(0);
    const scrollable = ref(false);
    const gutter = ref(0);

    const element = (): HTMLElement | undefined => scroller.value ?? undefined;

    // Each heading's offset from the scroll box top; re-derived on every measure, never a node reference.
    let tops: number[] = [];
    let mutations: MutationObserver | undefined;
    let resizes: ResizeObserver | undefined;
    // Prose element the resize observer watches; re-observing the same element would loop re-measure/re-observe.
    let watched: Element | undefined;
    let measureFrame: number | undefined;
    let trackFrame: number | undefined;

    // Where the reader is, from the numbers alone; cheap enough to run on every scroll frame.
    const track = (): void => {
        const view = element();
        if (view === undefined) {
            return;
        }
        const travel = view.scrollHeight - view.clientHeight;
        active.value = activeAt(tops, view.scrollTop, travel - view.scrollTop <= END_SLACK);
        progress.value = progressAt(view.scrollTop, view.scrollHeight, view.clientHeight);
        scrollable.value = travel > END_SLACK;
    };

    // What the document is and where its headings sit. Forces layout, so it runs on mutation and resize only.
    const measure = (): void => {
        const view = element();
        if (view === undefined) {
            tops = [];
            headings.value = [];
            active.value = -1;
            progress.value = 0;
            scrollable.value = false;
            gutter.value = 0;
            return;
        }
        gutter.value = view.offsetWidth - view.clientWidth;
        // One query serves both answers; a second DOM walk would find nothing the first didn't already.
        const nodes = headingNodes(view);
        // Scroll box's origin (position at scrollTop 0), independent of current scroll.
        const origin = view.getBoundingClientRect().top - view.scrollTop;
        tops = nodes.map((node) => node.getBoundingClientRect().top - origin);
        const found = nodes.map(toHeading);
        if (!sameHeadings(found, headings.value)) {
            headings.value = found;
        }
        // Images and figures resize after paint, moving headings below; watching the pane alone would miss it.
        const content = view.firstElementChild ?? undefined;
        if (content !== watched) {
            if (watched !== undefined) {
                resizes?.unobserve(watched);
            }
            watched = content;
            if (content !== undefined) {
                resizes?.observe(content);
            }
        }
        track();
    };

    const scheduleMeasure = (): void => {
        measureFrame ??= requestAnimationFrame(() => {
            measureFrame = undefined;
            measure();
        });
    };

    const onScroll = (): void => {
        trackFrame ??= requestAnimationFrame(() => {
            trackFrame = undefined;
            track();
        });
    };

    const detach = (view: HTMLElement | undefined): void => {
        view?.removeEventListener(`scroll`, onScroll);
        mutations?.disconnect();
        resizes?.disconnect();
        mutations = undefined;
        resizes = undefined;
        watched = undefined;
    };

    // Jumps instantly, never animated: an outline exists to skip scrolling, not add more of it.
    const jump = (index: number): void => {
        const view = element();
        const top = tops[index];
        if (view === undefined || top === undefined) {
            return;
        }
        view.scrollTop = Math.max(0, top - JUMP_INSET);
    };

    watch(
        scroller,
        (next, was) => {
            detach(was ?? undefined);
            const view = next ?? undefined;
            if (view === undefined) {
                measure();
                return;
            }
            view.addEventListener(`scroll`, onScroll, { passive: true });
            // childList/subtree only: blocks get replaced wholesale (new doc, code highlighting), not edited in place.
            mutations = new MutationObserver(scheduleMeasure);
            mutations.observe(view, { childList: true, subtree: true });
            resizes = new ResizeObserver(scheduleMeasure);
            // The pane itself; a narrower column re-wraps the prose and moves every heading in it.
            resizes.observe(view);
            measure();
        },
        { immediate: true, flush: `post` },
    );

    onBeforeUnmount(() => {
        detach(element());
        if (measureFrame !== undefined) {
            cancelAnimationFrame(measureFrame);
        }
        if (trackFrame !== undefined) {
            cancelAnimationFrame(trackFrame);
        }
    });

    return { headings, active, progress, scrollable, gutter, jump };
};
