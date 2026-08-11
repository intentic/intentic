import { onBeforeUnmount, ref, watch, type Ref } from "vue";

/* The reader's place in a rendered document, and the list of places they can jump to — the data behind the
 * preview's outline rail (MarkdownOutline.vue).
 *
 * READ OFF THE RENDERED DOM, NOT THE SOURCE. The headings are whatever `<h1>`–`<h4>` the prose surface actually
 * painted, found by querying the scroll container. That is the ground truth for a thing whose entire job is
 * scrolling to a position: a source-side scan would have to re-implement the parser's mind about fenced blocks,
 * setext headings and figure fences, and would still be guessing at the layout. It also means a document split
 * into runs by a figure (see Markdown.vue) needs no special case at all — document order is document order.
 *
 * THE DOM UNDERNEATH IS REPLACED WITHOUT WARNING, which is why nothing here holds a node between frames. A code
 * block's highlighting lands after the first paint and re-renders the whole v-html (markdown/code.ts), so every
 * heading element is swapped for a fresh one — an observer attached to the old ones would silently stop
 * reporting, and a remembered node would scroll to a position no longer in the document. A MutationObserver
 * re-measures instead, and the measurement is a list of NUMBERS (each heading's offset in the scroll box), which
 * survives the swap because the layout does. */

export interface OutlineHeading {
    // 1–4, matching the levels prose.css styles. Drawn as indentation, never as a number.
    readonly level: number;
    readonly text: string;
}

const HEADINGS = `h1, h2, h3, h4`;

/* Where "you are here" is measured, in pixels below the scroller's top edge. A section becomes current once its
 * heading crosses this line, not when it touches the top edge — at the top edge the heading you just scrolled
 * past is still filling the screen, so the rail would name the section you have left. */
const ACTIVE_LINE = 72;

// A jumped-to heading lands this far below the top edge, so it reads as a heading with a document under it
// rather than as text jammed against the frame. Must stay under ACTIVE_LINE or a jump would not mark its own row.
const JUMP_INSET = 16;

// The scroll positions two floats apart are the same position — browsers report fractional scrollTop, so an
// exact comparison never sees the bottom.
const END_SLACK = 2;

/** Which heading the reader is inside, given each one's offset in the scroll box. -1 when there are none. */
export const activeAt = (tops: readonly number[], scrollTop: number, atEnd: boolean): number => {
    if (tops.length === 0) {
        return -1;
    }
    /* The last heading whose section a short document can never scroll to the top would otherwise never be
     * current — the document runs out of travel first. At the bottom, the last section IS where you are. */
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

/** How far through the document the reader is, 0–1. A document that fits its pane is fully read. */
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

// A heading's own words on one line. `## \`api.views\` — the surfaces` is three text nodes and a newline in the
// source; the rail has one row to say it in.
const headingText = (node: Element): string => (node.textContent ?? ``).replaceAll(/\s+/gu, ` `).trim();

// The heading elements the prose is showing, in document order. One with no text — a bare `#`, or a level
// marker whose content has not arrived — is furniture, not a section, and is skipped.
const headingNodes = (view: ParentNode): HTMLElement[] =>
    [...view.querySelectorAll<HTMLElement>(HEADINGS)].filter((node) => headingText(node) !== ``);

const toHeading = (node: Element): OutlineHeading => ({ level: Number(node.tagName.slice(1)), text: headingText(node) });

/** Every heading the prose is showing, in document order. */
export const readHeadings = (view: ParentNode): OutlineHeading[] => headingNodes(view).map(toHeading);

// Whether a re-measure found the same document. Compared so the rail is not rebuilt — losing hover, focus and
// the filter's scroll position — every time a code block finishes highlighting.
const sameHeadings = (a: readonly OutlineHeading[], b: readonly OutlineHeading[]): boolean =>
    a.length === b.length && a.every((heading, index) => heading.level === b[index]?.level && heading.text === b[index]?.text);

export interface MarkdownOutline {
    /** Every heading in the rendered document, in order. */
    readonly headings: Ref<OutlineHeading[]>;
    /** Index into `headings` of the section the reader is in; -1 when the document has none. */
    readonly active: Ref<number>;
    /** Scroll position through the document, 0–1. */
    readonly progress: Ref<number>;
    /** Whether the document is longer than its pane. False means `progress` has nothing to report. */
    readonly scrollable: Ref<boolean>;
    /** Scroll heading `index` into view. */
    readonly jump: (index: number) => void;
}

/**
 * Track the headings inside `scroller` and where the reader is among them.
 *
 * @param scroller The element that scrolls the prose — its scroll box is what every offset here is measured in.
 *   Declared as possibly NULL as well as undefined, and read through `element()` below, because a template ref
 *   is written both ways: `ref<HTMLElement>()` starts life `undefined`, but Vue puts `null` in it when the
 *   element unmounts — which for the caller is every switch to the Source view. A guard that only tested for
 *   `undefined` typechecked, then threw on the null the moment the reader left the preview.
 */
export const useMarkdownOutline = (scroller: Readonly<Ref<HTMLElement | null | undefined>>): MarkdownOutline => {
    const headings = ref<OutlineHeading[]>([]);
    const active = ref(-1);
    const progress = ref(0);
    const scrollable = ref(false);

    const element = (): HTMLElement | undefined => scroller.value ?? undefined;

    // Each heading's offset from the top of the scroll box. Re-derived on every measure; never a node reference.
    let tops: number[] = [];
    let mutations: MutationObserver | undefined;
    let resizes: ResizeObserver | undefined;
    // The prose element the size observer is watching. Held so a re-measure only re-observes when the surface
    // has genuinely been replaced — re-observing the same element fires the observer again, which would
    // re-measure, which would re-observe.
    let watched: Element | undefined;
    let measureFrame: number | undefined;
    let trackFrame: number | undefined;

    // Where the reader is, from the numbers alone — cheap enough to run on every scroll frame.
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
            return;
        }
        // One query for both answers: a re-measure runs on every mutation the prose makes, and the second walk
        // of a long document's DOM bought nothing the first had not already found.
        const nodes = headingNodes(view);
        // Distance from the top of the scroll box: viewport position, minus the box's own, plus how far it is scrolled.
        const origin = view.getBoundingClientRect().top - view.scrollTop;
        tops = nodes.map((node) => node.getBoundingClientRect().top - origin);
        const found = nodes.map(toHeading);
        if (!sameHeadings(found, headings.value)) {
            headings.value = found;
        }
        // Images and figures settle their height after the prose paints, which moves every heading below them.
        // Watching the prose itself is what catches that; watching only the pane would miss it entirely.
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

    /* INSTANT, NOT SMOOTH, and that is the whole design of this function. Animating the jump was measured on a
     * 30,000px document: clicking the second-to-last section took 1.6 SECONDS of blurred prose to arrive, during
     * which the rail's highlight raced down every section in between. An outline is the control you reach for
     * BECAUSE scrolling is too slow; making it scroll is the one thing it must not do. Nothing in this category
     * animates it either — GitHub's outline is anchor links, VS Code and Obsidian reveal outright. With no
     * animation there is also no motion to reduce, which is why no media query is consulted here. */
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
            // childList/subtree only: what changes here is whole blocks being replaced (a new document, a code
            // block gaining its colours), never text edited in place.
            mutations = new MutationObserver(scheduleMeasure);
            mutations.observe(view, { childList: true, subtree: true });
            resizes = new ResizeObserver(scheduleMeasure);
            // The pane itself: a narrower column re-wraps the prose and moves every heading in it.
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

    return { headings, active, progress, scrollable, jump };
};
