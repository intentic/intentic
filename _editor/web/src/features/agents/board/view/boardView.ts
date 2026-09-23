import { type Ref, shallowRef, watch } from "vue";

// How this one board is being looked at, as one value only `stepView` moves: Finished's window or all of it, the archive
// standing in its place a page at a time, and what a query found off the board. Held per board, not in the store: it is
// how this board is being read, not something a second surface should inherit.

// The archive is paged, not self-limiting like the lanes: drawn whole, a large one is thousands of cards in one frame.
export const ARCHIVE_PAGE = 30;

// A record, not a union: each part outlives the others' moves, as the lane's expand outlives an archive visit.
export interface BoardView {
    // The archive stands in the Finished column.
    readonly archive: boolean;
    // Finished's own expand, lifting its window.
    readonly all: boolean;
    // Archive rows drawn: grows a page at a time, since the pile is browsed and searched, unlike Finished's window.
    readonly shown: number;
    // This visit emptied the archive: an empty list otherwise reads as "nothing archived yet" to whoever just did it.
    readonly purged: boolean;
    // What a query found off the board is unfolded; folded until asked for.
    readonly beyond: boolean;
}

export type ViewEvent =
    // The archive's door: opens at one page, so the tenth opening costs what the first did, or closes.
    | { readonly kind: `door` }
    | { readonly kind: `more` }
    | { readonly kind: `expand` }
    // A new query is a new list: a deep page or unfolded matches describe a set that no longer exists.
    | { readonly kind: `requery` }
    // A link uncovering its card: the archive for an archived one, the whole lane for one outside the window.
    | { readonly kind: `uncover`; readonly into: `archive` | `lane` }
    | { readonly kind: `purged` }
    | { readonly kind: `beyond` };

export const VIEW_START: BoardView = { archive: false, all: false, shown: ARCHIVE_PAGE, purged: false, beyond: false };

type Moves = { readonly [K in ViewEvent["kind"]]: (view: BoardView, event: Extract<ViewEvent, { kind: K }>) => BoardView };

// Every move there is, one entry per event; one that changes nothing hands back the same value, so nothing re-runs.
const MOVES: Moves = {
    door: (view) => (view.archive ? { ...view, archive: false, purged: false } : { ...view, archive: true, shown: ARCHIVE_PAGE, purged: false }),
    more: (view) => ({ ...view, shown: view.shown + ARCHIVE_PAGE }),
    expand: (view) => ({ ...view, all: !view.all }),
    requery: (view) => (view.shown === ARCHIVE_PAGE && !view.beyond ? view : { ...view, shown: ARCHIVE_PAGE, beyond: false }),
    uncover: (view, { into }) => {
        if (into === `archive`) {
            return view.archive ? view : { ...view, archive: true };
        }
        return view.all ? view : { ...view, all: true };
    },
    purged: (view) => (view.purged ? view : { ...view, purged: true }),
    beyond: (view) => ({ ...view, beyond: !view.beyond }),
};

// The table is keyed by the event's own kind, so the entry read always takes the event it is handed.
export const stepView = (view: BoardView, event: ViewEvent): BoardView =>
    (MOVES[event.kind] as (view: BoardView, event: ViewEvent) => BoardView)(view, event);

// Finished's window applies only while browsing its own recent tail: a filter or the expand lifts it, the archive
// replaces it.
export const windowedIn = (view: BoardView, filtering: boolean): boolean => !view.archive && !filtering && !view.all;

// One mounted board's view, moved by its presses and by every new query.
export const useBoardView = (needle: Readonly<Ref<string>>) => {
    const view = shallowRef<BoardView>(VIEW_START);
    const move = (event: ViewEvent): void => {
        view.value = stepView(view.value, event);
    };
    watch(needle, () => move({ kind: `requery` }));
    return { view, move };
};
