import "@intentic/testing/dom";
import { effectScope } from "vue";
import { COPIED_MS, readClipboard, useCopied, writeClipboard } from "@intentic/ui/clipboard";

// The kit's one door to the clipboard: a write says whether it landed and never rejects, and the "Copied"
// acknowledgement goes up only for a write that landed and comes down on one clock.
const held = Object.getOwnPropertyDescriptor(navigator, `clipboard`);
const clipboard = (writeText: (text: string) => Promise<void>, readText: () => Promise<string> = async () => ``): void => {
    Object.defineProperty(navigator, `clipboard`, { value: { writeText, readText }, configurable: true });
};
afterEach(() => {
    jest.useRealTimers();
    if (held === undefined) {
        Reflect.deleteProperty(navigator, `clipboard`);
    } else {
        Object.defineProperty(navigator, `clipboard`, held);
    }
});

test("a write that lands says so, and one the browser refuses answers false instead of rejecting", async () => {
    const written: string[] = [];
    clipboard(async (text) => {
        written.push(text);
    });
    expect(await writeClipboard(`ok`)).toBe(true);

    clipboard(async () => {
        throw new DOMException(`Document is not focused.`, `NotAllowedError`);
    });
    expect({ refused: await writeClipboard(`no`), written }).toEqual({ refused: false, written: [`ok`] });
});

test("with no clipboard at all (an insecure context) a write is false and a read is nothing", async () => {
    Object.defineProperty(navigator, `clipboard`, { value: undefined, configurable: true });
    expect({ wrote: await writeClipboard(`x`), read: await readClipboard() }).toEqual({ wrote: false, read: undefined });
});

test("the write goes through the pressed element's own window, not this realm's", async () => {
    const mine: string[] = [];
    const theirs: string[] = [];
    clipboard(async (text) => {
        mine.push(text);
    });
    // An element living in another window's document: only that document's window is asked.
    const popped = document.createElement(`button`);
    Object.defineProperty(popped, `ownerDocument`, {
        value: { defaultView: { navigator: { clipboard: { writeText: async (text: string) => theirs.push(text) } } } },
    });

    await writeClipboard(`from the popped-out window`, popped);

    expect({ mine, theirs }).toEqual({ mine: [], theirs: [`from the popped-out window`] });
});

test("copied goes up for a landed write and comes down after the shared hold", async () => {
    clipboard(async () => undefined);
    jest.useFakeTimers();
    const { copied, copy } = effectScope().run(() => useCopied())!;

    expect(await copy(`x`)).toBe(true);
    expect(copied.value).toBe(true);
    jest.advanceTimersByTime(COPIED_MS - 1);
    expect(copied.value).toBe(true);
    jest.advanceTimersByTime(1);
    expect(copied.value).toBe(false);
});

test("a refused write never claims it copied", async () => {
    clipboard(async () => {
        throw new DOMException(`Write permission denied.`, `NotAllowedError`);
    });
    const { copied, copy } = effectScope().run(() => useCopied())!;

    expect({ landed: await copy(`x`), copied: copied.value }).toEqual({ landed: false, copied: false });
});

test("a held acknowledgement stays up until it is reset", async () => {
    clipboard(async () => undefined);
    jest.useFakeTimers();
    const { copied, copy, reset } = useCopied(Number.POSITIVE_INFINITY);

    await copy(`x`);
    jest.advanceTimersByTime(60_000);
    expect(copied.value).toBe(true);
    reset();
    expect(copied.value).toBe(false);
});
