import "@intentic/testing/dom";
import { receivePreferenceChange } from "@intentic/ui/preference";
import { DISMISS_STEP_MS, dismissRows, REVEAL_ROWS, REVEAL_STEP_MS, revealRows, rowsUnder, settleDismissed } from "@intentic/ui/motion";

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

// An exit the test DOM can await and cancel: `finished` settles at once, and a cancel is counted against its row.
const recordExits = (root: HTMLElement): { played: Played[]; cancelled: string[] } => {
    const played: Played[] = [];
    const cancelled: string[] = [];
    for (const row of root.querySelectorAll<HTMLElement>(`[data-reveal]`)) {
        const runs: Animation[] = [];
        row.animate = ((_frames: Keyframe[], timing: KeyframeAnimationOptions) => {
            played.push({ row: row.id, delay: Number(timing.delay ?? 0) });
            // SAFETY: dismissRows reads only `finished`, and settleDismissed only `id` and `cancel`.
            const run = { id: timing.id, finished: Promise.resolve(), cancel: () => cancelled.push(row.id) } as unknown as Animation;
            runs.push(run);
            return run;
        }) as HTMLElement[`animate`];
        row.getAnimations = () => runs;
    }
    return { played, cancelled };
};

describe(`dismissRows`, () => {
    it(`plays the rows out in reading order, quicker than they came in and on the same cap`, async () => {
        const root = build(Array.from({ length: REVEAL_ROWS + 2 }, (_, index) => `<div id="r${index}" data-reveal></div>`).join(``));
        const { played } = recordExits(root);

        await dismissRows(rowsUnder(root)[0] ?? []);

        expect(played.slice(0, 2)).toEqual([
            { row: `r0`, delay: 0 },
            { row: `r1`, delay: DISMISS_STEP_MS },
        ]);
        expect(DISMISS_STEP_MS).toBeLessThan(REVEAL_STEP_MS);
        expect(Math.max(...played.map((entry) => entry.delay))).toBe((REVEAL_ROWS - 1) * DISMISS_STEP_MS);
    });

    it(`settles at once, having played nothing, when motion is off`, async () => {
        receivePreferenceChange({ key: `ui-motion`, raw: `off` });
        const root = build(`<div id="r1" data-reveal></div>`);
        const { played } = recordExits(root);

        await dismissRows(rowsUnder(root)[0] ?? []);

        expect(played).toEqual([]);
    });

    it(`lets a row that outlived its removal be drawn again`, async () => {
        const root = build(`<div id="r1" data-reveal></div><div id="r2" data-reveal></div>`);
        const { cancelled } = recordExits(root);
        const rows = rowsUnder(root)[0] ?? [];

        await dismissRows(rows);
        settleDismissed(rows);

        expect(cancelled).toEqual([`r1`, `r2`]);
    });
});
