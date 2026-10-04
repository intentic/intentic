import { onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";
import { canAnimate } from "./fold.js";
import { lessMotion } from "./preference.js";

// ROWS ARRIVING IN READING ORDER. When a list of sessions shows (the agents board, the chat's lanes, the rail's
// checklist and usage), its rows play into place top to bottom: each rises a few pixels as it comes in, and row `i`
// starts `i` steps after the first. On a board of lanes the step is shared across lanes, so row one of every lane
// lands together, then row two: the board fills side by side, the way it is read, and the whole opening takes the
// rows of the longest lane rather than every card in turn. Lane headings and empty-lane notes do not move: the frame
// is there at once, and only what is in it arrives.
//
// It is quick on purpose, and capped: past the eighth row every row starts with the eighth, so a long lane costs no
// more time than a short one, and the last row is still in place under half a second after the first.
//
// Played as Web Animations on `translate` and `opacity` (compositor-only, and `translate` rather than `transform`, so a
// card's own flight or fold keeps running beside it), held at their first frame through their delay (`backwards`),
// and gone once finished, so a row at rest carries nothing. Skipped outright when motion is off (preference.ts).

/** How long one row takes to arrive. */
export const REVEAL_MS = 240;
/** The step between one row and the next. */
export const REVEAL_STEP_MS = 32;
/** Rows past this one start with it. */
export const REVEAL_ROWS = 8;
/** How far a row rises into its place. */
export const REVEAL_RISE_PX = 8;
// The house curve (motion.css `--ease-smooth`): most of the way there in the first frames, then a long settle.
const REVEAL_EASE = `cubic-bezier(0.22, 1, 0.36, 1)`;
// Tags this module's animations among an element's, so nothing else's is mistaken for one.
const REVEAL = `row-reveal`;

const ROW = `[data-reveal]`;
const COLUMN = `[data-reveal-column]`;

/**
 * The rows under `root`, by column. Every `[data-reveal-column]` is a column (a board's lane); with none, the root is
 * the one column (a rail). A row is a `[data-reveal]` whose nearest marked ancestor is its own column, so a row
 * nested in another row (a card's children) travels with its card rather than arriving again on its own.
 */
export const rowsUnder = (root: Element): Element[][] => {
    const columns = [...root.querySelectorAll(COLUMN)];
    const scopes = columns.length > 0 ? columns : [root];
    return scopes.map((scope) =>
        [...scope.querySelectorAll(ROW)].filter((row) => {
            const owner = row.parentElement?.closest(`${ROW}, ${COLUMN}`) ?? null;
            return owner === scope || (scope === root && (owner === null || !root.contains(owner)));
        }),
    );
};

/** Plays rows into place: row `i` of every column starts `i` steps after the first (capped at REVEAL_ROWS). */
export const revealRows = (columns: readonly (readonly Element[])[]): void => {
    if (lessMotion()) {
        return;
    }
    for (const column of columns) {
        column.forEach((row, index) => {
            if (!canAnimate(row)) {
                return;
            }
            row.animate(
                [
                    { opacity: 0, translate: `0 ${REVEAL_RISE_PX}px` },
                    { opacity: 1, translate: `0 0` },
                ],
                { duration: REVEAL_MS, delay: Math.min(index, REVEAL_ROWS - 1) * REVEAL_STEP_MS, easing: REVEAL_EASE, fill: `backwards`, id: REVEAL },
            );
        });
    }
};

export interface RowRevealOptions {
    /** What changes when rows come and go: a render that changes it is when new rows are looked for. */
    readonly key: () => string;
    /**
     * How long after mounting the first rows may still turn up and be played in as the list's opening (ms), for a list
     * whose rows are read after it mounts. Past it, an empty list simply fills. Default 1500.
     */
    readonly wait?: number;
    /**
     * Whether a row that arrives after the opening plays in too, on its own (several at once in their order): a new
     * item on a checklist, a chat starting in a lane, a whole persona's lanes swapped in. Off, later rows are the
     * caller's to animate (the board's lanes have an entrance of their own) or simply appear.
     */
    readonly arrivals?: boolean;
}

export interface RowReveal {
    /** True once the opening has played (or had nothing to play): from here on a row that arrives is news. */
    readonly settled: Readonly<Ref<boolean>>;
}

/** Plays the rows under `root` in as the list opens, and (with `arrivals`) each row that arrives later. */
export const useRowReveal = (root: Readonly<Ref<Element | null | undefined>>, { key, wait = 1500, arrivals = false }: RowRevealOptions): RowReveal => {
    const seen = new WeakSet<Element>();
    const settled = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The rows of each column that have not been drawn before, keeping their order.
    const fresh = (): Element[][] => {
        const at = root.value;
        if (!at) {
            return [];
        }
        return rowsUnder(at).map((column) => column.filter((row) => !seen.has(row)));
    };

    const settle = (): void => {
        clearTimeout(timer);
        timer = undefined;
        for (const column of fresh()) {
            for (const row of column) {
                seen.add(row);
            }
        }
        settled.value = true;
    };

    const look = (): void => {
        const columns = fresh().filter((column) => column.length > 0);
        if (columns.length === 0) {
            return;
        }
        if (settled.value && !arrivals) {
            columns.flat().forEach((row) => seen.add(row));
            return;
        }
        revealRows(columns);
        columns.flat().forEach((row) => seen.add(row));
        if (!settled.value) {
            // The next frame, so a row the opening render is still drawing counts as part of it.
            requestAnimationFrame(settle);
        }
    };

    onMounted(() => {
        look();
        if (!settled.value) {
            timer = setTimeout(settle, wait);
        }
    });
    watch(key, look, { flush: `post` });
    onBeforeUnmount(() => clearTimeout(timer));

    return { settled };
};
