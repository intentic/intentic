// A copy made in the sandbox's browser reaches the person's clipboard: at once when the stage has focus and the browser
// takes the write, else on the person's next press in the stage within five seconds, unless they copied something
// themselves meanwhile; only the newest copy is ever held.
import "@intentic/testing/dom";
import type { ClipboardContent } from "@intentic/sandbox-contract/browser-wire";
import { clipboardOut, copiesIn, stageHasFocus } from "./clipboardOut";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const harness = (focused: boolean, refuse = false) => {
    const written: ClipboardContent[] = [];
    let focus = focused;
    let refusing = refuse;
    let now = 1000;
    const listeners = new Set<() => void>();
    const out = clipboardOut({
        focused: () => focus,
        write: async (content) => {
            if (refusing) {
                throw new Error(`NotAllowedError`);
            }
            written.push(content);
        },
        listen: (onCopy) => {
            listeners.add(onCopy);
            return () => listeners.delete(onCopy);
        },
        now: () => now,
    });
    return {
        out,
        written,
        listeners,
        focus: (on: boolean) => (focus = on),
        refuse: (on: boolean) => (refusing = on),
        advance: (ms: number) => (now += ms),
        // The person copies or cuts something themselves in the stage's document.
        copyLocally: () => [...listeners].forEach((listener) => listener()),
    };
};

it("writes a copy at once while the stage has focus", async () => {
    const { out, written } = harness(true);
    out.remote({ text: `hello`, html: `<b>hello</b>` });
    await settle();
    expect(written).toEqual([{ text: `hello`, html: `<b>hello</b>` }]);
    expect(out.held()).toBeUndefined();
});

it("holds a copy made while the stage has no focus, and writes it at the next gesture", async () => {
    const { out, written, focus } = harness(false);
    out.remote({ text: `later` });
    expect(written).toEqual([]);
    expect(out.held()).toEqual({ text: `later` });
    focus(true);
    out.gesture();
    await settle();
    expect(written).toEqual([{ text: `later` }]);
    expect(out.held()).toBeUndefined();
});

it("holds a copy the browser refused, and tries again at the next gesture", async () => {
    const { out, written, refuse } = harness(true, true);
    out.remote({ png: `iVBORw0KGgo=` });
    await settle();
    expect(out.held()).toEqual({ png: `iVBORw0KGgo=` });
    refuse(false);
    out.gesture();
    await settle();
    expect(written).toEqual([{ png: `iVBORw0KGgo=` }]);
});

it("never holds an older copy over a newer one", async () => {
    const { out, written, refuse } = harness(true, true);
    out.remote({ text: `first` });
    refuse(false);
    out.remote({ text: `second` });
    await settle();
    expect(written).toEqual([{ text: `second` }]);
    expect(out.held()).toBeUndefined();
});

it("ignores an empty copy, and a gesture with nothing held writes nothing", async () => {
    const { out, written } = harness(true);
    out.remote({ text: `` });
    out.gesture();
    await settle();
    expect(written).toEqual([]);
});

it("lets a held copy go after five seconds, rather than writing it over whatever the person has copied since", async () => {
    const { out, written, advance, focus, listeners } = harness(false);
    out.remote({ text: `stale` });
    advance(5001);
    focus(true);
    out.gesture();
    await settle();
    expect(written).toEqual([]);
    expect(out.held()).toBeUndefined();
    expect(listeners.size).toBe(0);
});

it("writes a held copy at a gesture within five seconds", async () => {
    const { out, written, advance } = harness(false);
    out.remote({ text: `fresh` });
    advance(4900);
    out.gesture();
    await settle();
    expect(written).toEqual([{ text: `fresh` }]);
});

it("drops a held copy once the person copies something themselves, and stops listening", async () => {
    const { out, written, copyLocally, listeners } = harness(false);
    out.remote({ text: `theirs` });
    expect(listeners.size).toBe(1);
    copyLocally();
    out.gesture();
    await settle();
    expect(written).toEqual([]);
    expect(out.held()).toBeUndefined();
    expect(listeners.size).toBe(0);
});

it("listens for the person's own copies only while a copy is held", async () => {
    const { out, listeners, focus } = harness(false);
    out.remote({ text: `one` });
    out.remote({ text: `two` });
    expect(listeners.size).toBe(1);
    focus(true);
    out.gesture();
    await settle();
    expect(listeners.size).toBe(0);
    out.remote({ text: `three` });
    out.forget();
    expect(listeners.size).toBe(0);
});

describe("stageHasFocus", () => {
    const stage = () => {
        const root = document.createElement(`div`);
        root.tabIndex = 0;
        const sink = document.createElement(`textarea`);
        sink.tabIndex = -1;
        const canvas = document.createElement(`canvas`);
        const box = document.createElement(`div`);
        box.append(canvas);
        root.append(sink, box);
        const elsewhere = document.createElement(`button`);
        document.body.append(root, elsewhere);
        return { root, sink, canvas, elsewhere };
    };
    afterEach(() => document.body.replaceChildren());

    it("is the picture's focusable box, or its input sink inside it, holding the focus", () => {
        const { root, sink, canvas, elsewhere } = stage();
        root.focus();
        expect(stageHasFocus(canvas)).toBe(true);
        sink.focus();
        expect(stageHasFocus(canvas)).toBe(true);
        elsewhere.focus();
        expect(stageHasFocus(canvas)).toBe(false);
        expect(stageHasFocus(undefined)).toBe(false);
    });
});

it("hears the person's own copies and cuts in a document until stopped", () => {
    let heard = 0;
    const stop = copiesIn(document, () => (heard += 1));
    document.dispatchEvent(new Event(`copy`));
    document.body.dispatchEvent(new Event(`cut`, { bubbles: true }));
    stop();
    document.dispatchEvent(new Event(`copy`));
    expect(heard).toBe(2);
});
