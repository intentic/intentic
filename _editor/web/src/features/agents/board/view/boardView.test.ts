import { effectScope, nextTick, ref } from "vue";
import { ARCHIVE_PAGE, type BoardView, stepView, useBoardView, VIEW_START, type ViewEvent, windowedIn } from "./boardView";

// Pins every move the board's view makes, as values: the archive's door opens at one page and closes keeping the lane's
// expand, a page only ever adds, a new query folds what it made stale, and a link uncovers without resetting a thing.

const at = (over: Partial<BoardView>): BoardView => ({ ...VIEW_START, ...over });

describe(`the board's view`, () => {
    it(`opens the archive at one page with no purge said, however deep the last visit went`, () => {
        expect(stepView(at({ shown: 90, purged: true, all: true }), { kind: `door` })).toEqual(at({ archive: true, shown: ARCHIVE_PAGE, all: true }));
    });

    it(`closes the archive onto the lane as the reader left it, dropping the purge mark and keeping the page`, () => {
        expect(stepView(at({ archive: true, shown: 60, purged: true, all: true }), { kind: `door` })).toEqual(at({ shown: 60, all: true }));
    });

    it(`adds a page at a time, and expands and folds Finished without touching the archive`, () => {
        expect(stepView(at({ archive: true }), { kind: `more` })).toEqual(at({ archive: true, shown: 60 }));
        expect(stepView(at({ archive: true, shown: 60 }), { kind: `more` })).toEqual(at({ archive: true, shown: 90 }));
        expect(stepView(VIEW_START, { kind: `expand` })).toEqual(at({ all: true }));
        expect(stepView(at({ all: true, archive: true }), { kind: `expand` })).toEqual(at({ archive: true }));
    });

    it(`folds a deep page and the unfolded matches on a new query, and hands back the same view when nothing is stale`, () => {
        expect(stepView(at({ archive: true, shown: 90, beyond: true, all: true }), { kind: `requery` })).toEqual(at({ archive: true, all: true }));
        const settled = at({ archive: true, all: true });
        expect(stepView(settled, { kind: `requery` })).toBe(settled);
    });

    it(`uncovers a linked card without resetting the page or the purge mark, and changes nothing already open`, () => {
        const closed = at({ shown: 60, purged: true });
        expect(stepView(closed, { kind: `uncover`, into: `archive` })).toEqual(at({ archive: true, shown: 60, purged: true }));
        expect(stepView(VIEW_START, { kind: `uncover`, into: `lane` })).toEqual(at({ all: true }));
        const open = at({ archive: true, all: true });
        expect(stepView(open, { kind: `uncover`, into: `archive` })).toBe(open);
        expect(stepView(open, { kind: `uncover`, into: `lane` })).toBe(open);
    });

    it(`marks a purge once, and unfolds and folds what a query found off the board`, () => {
        expect(stepView(at({ archive: true }), { kind: `purged` })).toEqual(at({ archive: true, purged: true }));
        const purged = at({ archive: true, purged: true });
        expect(stepView(purged, { kind: `purged` })).toBe(purged);
        expect(stepView(VIEW_START, { kind: `beyond` })).toEqual(at({ beyond: true }));
        expect(stepView(at({ beyond: true }), { kind: `beyond` })).toEqual(VIEW_START);
    });

    it(`windows Finished only while browsing its own tail`, () => {
        expect([
            windowedIn(VIEW_START, false),
            windowedIn(VIEW_START, true),
            windowedIn(at({ all: true }), false),
            windowedIn(at({ archive: true }), false),
        ]).toEqual([true, false, false, false]);
    });
});

describe(`one mounted board's view`, () => {
    it(`moves on a press, and folds its page and matches back when the query changes`, async () => {
        const needle = ref(``);
        const scope = effectScope();
        const { view, move } = scope.run(() => useBoardView(needle))!;
        const presses: ViewEvent[] = [{ kind: `door` }, { kind: `more` }, { kind: `beyond` }];
        for (const event of presses) {
            move(event);
        }
        expect(view.value).toEqual(at({ archive: true, shown: 60, beyond: true }));

        needle.value = `login`;
        await nextTick();

        expect(view.value).toEqual(at({ archive: true }));
        scope.stop();
    });
});
