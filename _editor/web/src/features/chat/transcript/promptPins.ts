// WHICH PROMPTS ARE STUCK, answered once per scroller rather than once per prompt. A prompt pins to the top of the
// transcript while its turn scrolls beneath it (`.chat-prompt` in chat.css), and whether it actually is stuck is
// something CSS cannot ask, so it is measured: the row's top against the scroller's edge, on scroll and whenever a box
// that decides it resizes. That measurement used to be each prompt's own — two ResizeObservers, an IntersectionObserver
// and a scroll listener per prompt, one of them on the shared scroller and content, so every frame a streamed answer grew
// ran every prompt's callback, and each prompt's mount wrote `--chat-pin` and then read layout back: N forced layouts on
// open. Profiled opening a 420-row chat at 4× CPU throttle: 1.0s in getBoundingClientRect, 0.5s in that write.
//
// Here one IntersectionObserver says which prompts are on screen, one ResizeObserver watches the scroller, its content
// and the prompts themselves, and one scroll listener runs a pass over the prompts on screen. A pass reads every box it
// needs first and writes afterwards, so it costs one layout however many prompts it measures.

export interface PinnedPrompt {
    // The prompt row, which is `position: sticky` (chat.css).
    readonly element: HTMLElement;
    // Its turn, which carries `--chat-pin` for anything else sticky inside it (an open mark bar parks below the prompt).
    readonly host: HTMLElement | null;
    // Told whether the prompt is stuck; the row wears `.chat-prompt-pinned` from it.
    readonly pinned: (value: boolean) => void;
}

interface Row extends PinnedPrompt {
    // On screen, per the group's IntersectionObserver.
    visible: boolean;
    // The row's height while it wraps, remembered because a collapsed row cannot be asked what it would grow back to.
    loose: number;
    // What was last written as `--chat-pin`, so an unchanged height writes nothing.
    published: string | undefined;
}

interface Group {
    readonly scroller: HTMLElement;
    readonly rows: Map<Element, Row>;
    readonly intersection: IntersectionObserver;
    readonly resize: ResizeObserver;
    readonly onScroll: () => void;
    // Rows to measure on the next pass whether or not they are on screen: just registered, just crossed the edge of the
    // view, or just resized.
    readonly dirty: Set<Row>;
    queued: boolean;
}

const groups = new WeakMap<HTMLElement, Group>();

// One measurement over the rows that can be stuck (on screen) and the ones owed a look (dirty). Reads first — the
// scroller's edge once, then each row — and writes after, so the whole pass is one layout.
//
// PINNING SHORTENS THE TRANSCRIPT BY WHAT THE ONE-LINE TITLE FREES, so the pin cannot be measured without hysteresis worth
// that much: parked at the foot of the scroller there is no scroll left below to absorb the loss, the browser clamps
// scrollTop to the smaller maximum, and the row's own flow position drops by the freed px — past the edge, which unpins
// it, which restores the height, which pins it again, at frame rate, for as long as the reader stays at the foot of a
// turn whose remaining content is within one collapse of filling the pane. Below the edge by less than its own collapse
// freed, a row is still the pinned one. Compared against the midpoint of the row's 1px sticky offset (`top: -1px`), robust
// to fractional scroll positions and display scaling.
const measure = (group: Group): void => {
    const rows = [...group.rows.values()].filter((row) => row.visible || group.dirty.has(row));
    group.dirty.clear();
    if (rows.length === 0) {
        return;
    }
    const edge = group.scroller.getBoundingClientRect().top + group.scroller.clientTop;
    const readings = rows.map((row) => {
        // Read off the row rather than off its `pinned` state, which leads the DOM by a render: the next measurement has
        // to account for the geometry on screen, not the intent.
        const collapsed = row.element.classList.contains(`chat-prompt-pinned`);
        const height = row.element.offsetHeight;
        if (!collapsed) {
            row.loose = height;
        }
        const freed = collapsed ? Math.max(0, row.loose - height) : 0;
        return { row, height, stuck: row.element.getBoundingClientRect().top < edge - 0.5 + freed };
    });
    for (const { row, height, stuck } of readings) {
        // What this row covers while pinned: the row's last pixel sits 1px above the scroller's edge (`top: -1px`).
        const cover = `${height - 1}px`;
        if (cover !== row.published) {
            row.published = cover;
            row.host?.style.setProperty(`--chat-pin`, cover);
        }
        row.pinned(stuck);
    }
};

// Several prompts mount in one render; they are measured together once it is done, not one layout each.
const queue = (group: Group): void => {
    if (group.queued) {
        return;
    }
    group.queued = true;
    queueMicrotask(() => {
        group.queued = false;
        measure(group);
    });
};

const groupOf = (scroller: HTMLElement): Group => {
    const existing = groups.get(scroller);
    if (existing !== undefined) {
        return existing;
    }
    const rows = new Map<Element, Row>();
    const dirty = new Set<Row>();
    // The callbacks below reach the group only once the observers report, by which time it exists.
    const group: Group = {
        scroller,
        rows,
        dirty,
        queued: false,
        intersection: new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const row = rows.get(entry.target);
                    if (row !== undefined) {
                        row.visible = entry.isIntersecting;
                        // Measured on the way out too: a row carried off the top by its turn is left saying so.
                        dirty.add(row);
                    }
                }
                measure(group);
            },
            { root: scroller },
        ),
        resize: new ResizeObserver((entries) => {
            for (const entry of entries) {
                const row = rows.get(entry.target);
                if (row !== undefined) {
                    // A prompt that grew or shrank (a clamped prompt opened) owes its turn a new `--chat-pin`.
                    dirty.add(row);
                }
            }
            measure(group);
        }),
        onScroll: () => measure(group),
    };
    const { resize, onScroll } = group;
    // A row crosses the edge with nothing scrolled, too: content above it changes height or the box around it resizes.
    // Scroll anchoring hides most of that, but it is suppressed on any frame that changes a computed style on the
    // anchor's ancestors, which is what folding a row is, so both boxes are watched: the scroller's own (the pane or
    // window resized it) and the wrapper inside it (ChatPane's `content`, which grows as the turn does).
    resize.observe(scroller);
    if (scroller.firstElementChild !== null) {
        resize.observe(scroller.firstElementChild);
    }
    scroller.addEventListener(`scroll`, onScroll, { passive: true });
    groups.set(scroller, group);
    return group;
};

const release = (group: Group, row: Row): void => {
    group.rows.delete(row.element);
    group.dirty.delete(row);
    group.intersection.unobserve(row.element);
    group.resize.unobserve(row.element);
    row.host?.style.removeProperty(`--chat-pin`);
    if (group.rows.size === 0) {
        group.intersection.disconnect();
        group.resize.disconnect();
        group.scroller.removeEventListener(`scroll`, group.onScroll);
        groups.delete(group.scroller);
    }
};

// Watches one prompt in its scroller until the returned release is called (the row unmounted, stopped being a prompt).
// Measured once the render that mounted it is done, so a prompt already stuck (a transcript restored at the bottom)
// starts out pinned.
export const pinPrompt = (scroller: HTMLElement, prompt: PinnedPrompt): (() => void) => {
    const group = groupOf(scroller);
    // Taken to be on screen until the IntersectionObserver first says otherwise, as a scroll or resize landing before
    // its first report must still measure a row that mounted already stuck.
    const row: Row = { ...prompt, visible: true, loose: 0, published: undefined };
    group.rows.set(prompt.element, row);
    group.intersection.observe(prompt.element);
    group.resize.observe(prompt.element);
    group.dirty.add(row);
    queue(group);
    return () => release(group, row);
};
