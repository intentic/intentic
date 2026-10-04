import { type Ref, watch } from "vue";
import { lessMotion } from "./preference.js";

// HOW A TRAY FOLDS, AND HOW WHAT STANDS BELOW IT MAKES ROOM. Only transform-family properties and opacity animate off the
// main thread (Chromium's compositable properties); `height` and `grid-template-rows` re-lay the column out every frame,
// on the thread the press's own render is busy on, which is when a fold starts, since pressing a card is what folds it:
// the chat switching transcripts held the fold's frames, and it arrived late, half done, and stuttering. So a fold
// commits its final layout at once and plays the difference back as motion the compositor runs on its own (FLIP): the
// rows slide out from under their card inside a clip that does not move, and everything below slides by the same
// distance, on one duration and curve, started in the same frame, so the gap between them never opens or shuts mid-way.

export const FOLD_MS = 220;
export const FOLD_EASE = `cubic-bezier(0.2, 0, 0, 1)`;
// Tags this module's slides among an element's animations, so a fold stops its own and nothing else.
const SLIDE = `fold-slide`;

// A page without the Web Animations API (a test DOM) moves nothing and folds at once.
export const canAnimate = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && typeof el.animate === `function`;

// Slides an element from `dy` back to where it stands, on the individual `translate` property: a `transform` animation of
// its own (a lane's scale-in, a card's flight) keeps running beside it, where a second `transform` would take both off
// the compositor.
export const slideFrom = (el: HTMLElement, dy: number): void => {
    el.animate([{ translate: `0 ${dy}px` }, { translate: `0 0` }], { duration: FOLD_MS, easing: FOLD_EASE, id: SLIDE });
};

// Drops an element's slide where it stands. Read its place first: a slide cut short restarts from where it was on screen.
export const stopSlide = (el: HTMLElement): void => {
    for (const run of el.getAnimations?.() ?? []) {
        if (run.id === SLIDE) {
            run.cancel();
        }
    }
};

// The vertical offset an element is drawn at by its own `translate`, mid-slide included (0 at rest).
const drawnY = (el: HTMLElement): number => Number.parseFloat((getComputedStyle(el).translate ?? ``).split(` `)[1] ?? ``) || 0;

// THE TRAY'S OWN FOLD, as Vue <Transition> hooks on the box that opens and shuts, whose first child holds the rows.
// Opening, the box takes its full height at once and the rows slide down out of its top edge, the card's foot; the rows
// below the box are the host's to slide (useFoldFlip, the board's laneMotion). Shutting, the box leaves the flow in the
// same render, pinned where it stood, so the column closes up at once and what stood below slides up over it while its
// rows slide back under the card. The box's parent is its containing block (`relative`).
export const trayFold = {
    enter: (box: Element, done: () => void): void => {
        const rows = box.firstElementChild;
        if (!canAnimate(box) || !canAnimate(rows)) {
            done();
            return;
        }
        // A reader who asked for less motion gets the rows faded in where they stand: the column made room at once.
        const frames = lessMotion()
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                  { translate: `0 ${-box.offsetHeight}px`, opacity: 0 },
                  { translate: `0 0`, opacity: 1 },
              ];
        box.style.overflow = `clip`;
        const run = rows.animate(frames, { duration: FOLD_MS, easing: FOLD_EASE });
        // Cancelled only by the fold shutting mid-way, whose styles are then the box's: leave them alone.
        run.finished.then(
            () => {
                box.style.overflow = ``;
                done();
            },
            () => {},
        );
    },
    leave: (box: Element, done: () => void): void => {
        const rows = box.firstElementChild;
        // With less motion nothing below slides, so rows lingering there would be drawn over what closed up on them.
        if (!canAnimate(box) || !canAnimate(rows) || lessMotion()) {
            done();
            return;
        }
        // From wherever an opening fold had the rows, rather than from fully open.
        const fromY = drawnY(rows);
        const fromOpacity = Number(getComputedStyle(rows).opacity || 1);
        for (const run of rows.getAnimations?.() ?? []) {
            run.cancel();
        }
        const { offsetTop, offsetHeight } = box;
        Object.assign(box.style, { position: `absolute`, top: `${offsetTop}px`, left: `0`, right: `0`, overflow: `clip`, pointerEvents: `none` });
        const run = rows.animate(
            [
                { translate: `0 ${fromY}px`, opacity: fromOpacity },
                { translate: `0 ${-offsetHeight}px`, opacity: 0 },
            ],
            { duration: FOLD_MS, easing: FOLD_EASE, fill: `forwards` },
        );
        run.finished.then(done, done);
    },
};

// Where each unit under `root` stands, against the root's content box, so a scroll between two reads moves nothing.
const unitTops = (root: HTMLElement): Map<HTMLElement, number> => {
    const origin = root.getBoundingClientRect().top - root.scrollTop;
    return new Map([...root.querySelectorAll<HTMLElement>(`[data-fold-unit]`)].map((unit) => [unit, unit.getBoundingClientRect().top - origin]));
};

// A COLUMN THAT MAKES ROOM FOR ITS TRAYS: every `[data-fold-unit]` under `root` slides from where it stood before the
// render that `key` changing brings to where it stands after it. Measured in a pre-flush watcher, before any component
// of this render has touched the DOM, and played in a post-flush one, after all of them have. A unit inside another
// slides only by what its own move exceeds its outer unit's (a lane that slid carries its rows along).
export const useFoldFlip = (root: Readonly<Ref<HTMLElement | null | undefined>>, key: () => unknown): void => {
    let before: Map<HTMLElement, number> | undefined;
    watch(
        key,
        () => {
            before = root.value && !lessMotion() ? unitTops(root.value) : undefined;
        },
        { flush: `pre` },
    );
    watch(
        key,
        () => {
            const column = root.value;
            const was = before;
            before = undefined;
            if (!column || !was || !canAnimate(column)) {
                return;
            }
            // Stops first, then reads, then plays, so the column is laid out once.
            for (const unit of was.keys()) {
                stopSlide(unit);
            }
            const moved = new Map<HTMLElement, number>();
            for (const [unit, top] of unitTops(column)) {
                const from = was.get(unit);
                if (from !== undefined && from !== top) {
                    moved.set(unit, from - top);
                }
            }
            for (const [unit, dy] of moved) {
                const outer = unit.parentElement?.closest<HTMLElement>(`[data-fold-unit]`);
                const own = dy - (outer ? (moved.get(outer) ?? 0) : 0);
                if (Math.abs(own) >= 0.5) {
                    slideFrom(unit, own);
                }
            }
        },
        { flush: `post` },
    );
};
