import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { canKeep, drop, frameId, KEEP_MS, keep, MAX_KEPT, take } from "./frames.js";

// The lot of kept editors against jsdom, which has no `moveBefore`: a stand-in that moves with insertBefore is installed
// where a test means a browser that has it. jsdom loads no frame documents, so this is the bookkeeping, not the promise
// that a moved iframe keeps its document (Chrome's, checked by hand against a live editor).

type Movable = { moveBefore?: (node: Node, child: Node | null) => void };
const prototype = Element.prototype as Movable;

const withMoveBefore = (): void => {
    prototype.moveBefore = function (this: Element, node: Node, child: Node | null) {
        this.insertBefore(node, child);
    };
};

const frameIn = (parent: HTMLElement): HTMLIFrameElement => {
    const frame = document.createElement(`iframe`);
    frame.style.width = `100%`;
    frame.style.height = `100%`;
    parent.append(frame);
    return frame;
};

const slot = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    return element;
};

const ids = [`a.docx`, `b.docx`, `c.docx`, `d.docx`].map((path) => frameId(path, undefined, `edit`, `light`));

afterEach(() => {
    for (const id of ids) {
        drop(id);
    }
    delete prototype.moveBefore;
    document.body.replaceChildren();
});

describe(`a browser without moveBefore`, () => {
    it(`keeps nothing, so the frame goes with its viewer as before`, () => {
        const frame = frameIn(slot());
        expect(canKeep()).toBe(false);
        expect(keep(ids[0]!, { frame, session: `s` })).toBe(false);
        expect(take(ids[0]!, slot())).toBeUndefined();
    });
});

describe(`a browser with moveBefore`, () => {
    it(`parks a frame out of sight at a fixed size and hands the same frame back, full size`, () => {
        withMoveBefore();
        const home = slot();
        const frame = frameIn(home);
        expect(keep(ids[0]!, { frame, session: `s1` })).toBe(true);
        expect(home.contains(frame)).toBe(false);
        expect(frame.isConnected).toBe(true);
        expect(frame.parentElement?.getAttribute(`aria-hidden`)).toBe(`true`);
        expect(frame.style.width).toBe(`1px`);

        const next = slot();
        expect(take(ids[0]!, next)).toEqual({ frame, session: `s1` });
        expect(next.firstElementChild).toBe(frame);
        expect(frame.style.width).toBe(`100%`);
        expect(frame.style.height).toBe(`100%`);
        // Taken is taken: nothing is kept for that document any more.
        expect(take(ids[0]!, slot())).toBeUndefined();
    });

    it(`holds one editor per document, the newest, and ends the older one`, () => {
        withMoveBefore();
        const older = frameIn(slot());
        const newer = frameIn(slot());
        keep(ids[0]!, { frame: older, session: `old` });
        keep(ids[0]!, { frame: newer, session: `new` });
        expect(older.isConnected).toBe(false);
        expect(take(ids[0]!, slot())).toEqual({ frame: newer, session: `new` });
    });

    it(`holds at most a few, ending the one left longest ago`, () => {
        withMoveBefore();
        expect(MAX_KEPT).toBe(3);
        const frames = ids.map(() => frameIn(slot()));
        ids.forEach((id, index) => keep(id, { frame: frames[index]!, session: id }));
        expect(frames.map((frame) => frame.isConnected)).toEqual([false, true, true, true]);
        expect(take(ids[0]!, slot())).toBeUndefined();
        expect(take(ids[3]!, slot())?.frame).toBe(frames[3]);
    });

    it(`ends an editor nobody came back to`, () => {
        jest.useFakeTimers();
        try {
            withMoveBefore();
            const frame = frameIn(slot());
            keep(ids[0]!, { frame, session: `s` });
            jest.advanceTimersByTime(KEEP_MS - 1);
            expect(frame.isConnected).toBe(true);
            jest.advanceTimersByTime(1);
            expect(frame.isConnected).toBe(false);
            expect(take(ids[0]!, slot())).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
    });

    it(`ends every kept editor when the shell switches to another sandbox`, () => {
        withMoveBefore();
        const frames = ids.slice(0, 2).map(() => frameIn(slot()));
        frames.forEach((frame, index) => keep(ids[index]!, { frame, session: `s${index}` }));
        resetSandboxScope();
        expect(frames.map((frame) => frame.isConnected)).toEqual([false, false]);
        expect(take(ids[0]!, slot())).toBeUndefined();
        // The next sandbox keeps its own.
        const next = frameIn(slot());
        expect(keep(ids[0]!, { frame: next, session: `n` })).toBe(true);
        expect(take(ids[0]!, slot())?.frame).toBe(next);
    });

    it(`keeps nothing for a frame already off the page`, () => {
        withMoveBefore();
        const frame = document.createElement(`iframe`);
        expect(keep(ids[0]!, { frame, session: `s` })).toBe(false);
    });

    it(`tells apart the same file opened another way`, () => {
        expect(frameId(`a.docx`, undefined, `edit`, `light`)).not.toBe(frameId(`a.docx`, `conv-1`, `edit`, `light`));
        expect(frameId(`a.docx`, undefined, `edit`, `light`)).not.toBe(frameId(`a.docx`, undefined, `view`, `light`));
        expect(frameId(`a.docx`, undefined, `edit`, `light`)).not.toBe(frameId(`a.docx`, undefined, `edit`, `dark`));
    });
});
