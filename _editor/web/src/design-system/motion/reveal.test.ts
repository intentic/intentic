import "@intentic/testing/dom";
import { receivePreferenceChange } from "@intentic/ui/preference";
import { REVEAL_ROWS, REVEAL_STEP_MS, revealRows, rowsUnder } from "@intentic/ui/motion";

// The row reveal reads the page's own markup for what to play (`data-reveal`, `data-reveal-column`) and plays it as Web
// Animations, which the test DOM does not run: each row's `animate` is recorded instead, which is all the reveal hands
// the browser, the delay being the whole of "row by row".

interface Played {
    readonly row: string;
    readonly delay: number;
}

const build = (html: string): HTMLElement => {
    const root = document.createElement(`div`);
    root.innerHTML = html;
    document.body.append(root);
    return root;
};

// Every `[data-reveal]` under `root` records the animation it is handed, keyed by its `id`.
const record = (root: HTMLElement): Played[] => {
    const played: Played[] = [];
    for (const row of root.querySelectorAll<HTMLElement>(`[data-reveal]`)) {
        // SAFETY: the reveal reads nothing back from the animation it starts, so a stand-in that only records suffices.
        row.animate = ((_frames: Keyframe[], timing: KeyframeAnimationOptions) => {
            played.push({ row: row.id, delay: Number(timing.delay ?? 0) });
            // SAFETY: nothing in revealRows touches the animation it is handed back, so an empty object stands in for it.
            return {} as Animation;
        }) as HTMLElement[`animate`];
    }
    return played;
};

beforeEach(() => {
    document.body.innerHTML = ``;
    receivePreferenceChange({ key: `ui-motion`, raw: `on` });
});

afterEach(() => {
    receivePreferenceChange({ key: `ui-motion`, raw: null });
});

describe(`rowsUnder`, () => {
    it(`reads each lane as a column, in order, and a row inside a row as part of it`, () => {
        const root = build(`
            <h2>Lanes</h2>
            <section data-reveal-column><div id="a1" data-reveal><div id="child" data-reveal></div></div><div id="a2" data-reveal></div></section>
            <section data-reveal-column><p>Nothing here</p></section>
            <section data-reveal-column><div id="c1" data-reveal></div></section>`);

        expect(rowsUnder(root).map((column) => column.map((row) => row.id))).toEqual([[`a1`, `a2`], [], [`c1`]]);
    });

    it(`reads a root with no columns as one`, () => {
        const root = build(`<div id="r1" data-reveal></div><div><div id="r2" data-reveal></div></div>`);

        expect(rowsUnder(root).map((column) => column.map((row) => row.id))).toEqual([[`r1`, `r2`]]);
    });
});

describe(`revealRows`, () => {
    it(`starts row i of every lane together, a step after row i - 1`, () => {
        const root = build(`
            <section data-reveal-column><div id="a1" data-reveal></div><div id="a2" data-reveal></div></section>
            <section data-reveal-column><div id="b1" data-reveal></div></section>`);
        const played = record(root);

        revealRows(rowsUnder(root));

        expect(played).toEqual([
            { row: `a1`, delay: 0 },
            { row: `a2`, delay: REVEAL_STEP_MS },
            { row: `b1`, delay: 0 },
        ]);
    });

    it(`caps the wait, so a long lane opens no slower than a short one`, () => {
        const root = build(Array.from({ length: REVEAL_ROWS + 3 }, (_, index) => `<div id="r${index}" data-reveal></div>`).join(``));
        const played = record(root);

        revealRows(rowsUnder(root));

        expect(Math.max(...played.map((entry) => entry.delay))).toBe((REVEAL_ROWS - 1) * REVEAL_STEP_MS);
    });

    it(`plays nothing when motion is off`, () => {
        receivePreferenceChange({ key: `ui-motion`, raw: `off` });
        const root = build(`<div id="r1" data-reveal></div>`);
        const played = record(root);

        revealRows(rowsUnder(root));

        expect(played).toEqual([]);
    });
});
