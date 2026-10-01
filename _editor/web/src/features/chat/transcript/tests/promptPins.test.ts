import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { pinPrompt } from "../promptPins";

// The scroller's one watcher over its prompts: which is stuck, told to each row, and `--chat-pin` written on its turn —
// measured together, so a render mounting many prompts costs one layout rather than one per prompt.

type Callback = (entries: { target: Element; isIntersecting?: boolean }[]) => void;
const intersections: { callback: Callback; observed: Set<Element> }[] = [];
const resizes: { callback: Callback; observed: Set<Element> }[] = [];

class FakeIntersection {
    readonly observed = new Set<Element>();
    constructor(readonly callback: Callback) {
        intersections.push(this);
    }
    observe(target: Element): void {
        this.observed.add(target);
    }
    unobserve(target: Element): void {
        this.observed.delete(target);
    }
    disconnect(): void {
        this.observed.clear();
    }
}
class FakeResize extends FakeIntersection {
    constructor(callback: Callback) {
        super(callback);
        intersections.pop();
        resizes.push(this);
    }
}

// A box whose top, and a row whose height, the test sets; each read is counted.
const reads = { scroller: 0, rows: 0 };
const scrollerAt = (top: number): HTMLElement => {
    const scroller = document.createElement(`div`);
    scroller.append(document.createElement(`div`));
    scroller.getBoundingClientRect = () => {
        reads.scroller += 1;
        // SAFETY: the watcher reads only `top` off the scroller's box.
        return { top } as DOMRect;
    };
    document.body.append(scroller);
    return scroller;
};
const promptAt = (scroller: HTMLElement, box: { top: number; height: number }) => {
    const host = document.createElement(`section`);
    const element = document.createElement(`div`);
    host.append(element);
    scroller.firstElementChild!.append(host);
    element.getBoundingClientRect = () => {
        reads.rows += 1;
        // SAFETY: the watcher reads only `top` off a prompt's box.
        return { top: box.top } as DOMRect;
    };
    Object.defineProperty(element, `offsetHeight`, { configurable: true, get: () => box.height });
    const said: boolean[] = [];
    return { host, element, box, said, pinned: (value: boolean) => said.push(value) };
};
const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

beforeEach(() => {
    intersections.length = 0;
    resizes.length = 0;
    reads.scroller = 0;
    reads.rows = 0;
    stubGlobal(`IntersectionObserver`, FakeIntersection);
    stubGlobal(`ResizeObserver`, FakeResize);
});

afterEach(() => {
    unstubAllGlobals();
    document.body.innerHTML = ``;
});

it(`measures the prompts one render mounted together, reading the scroller's edge once`, async () => {
    const scroller = scrollerAt(100);
    const above = promptAt(scroller, { top: 90, height: 40 });
    const below = promptAt(scroller, { top: 400, height: 30 });
    pinPrompt(scroller, above);
    pinPrompt(scroller, below);
    await settle();

    expect({ above: above.said, below: below.said }).toEqual({ above: [true], below: [false] });
    expect(reads.scroller).toBe(1);
    expect(intersections).toHaveLength(1);
    expect(resizes).toHaveLength(1);
    // The turn is told what its prompt covers while pinned: the row's height, less its 1px sticky offset.
    expect(above.host.style.getPropertyValue(`--chat-pin`)).toBe(`39px`);
});

it(`measures only the prompts on screen when the transcript scrolls`, async () => {
    const scroller = scrollerAt(100);
    const shown = promptAt(scroller, { top: 300, height: 40 });
    const hidden = promptAt(scroller, { top: 5_000, height: 40 });
    pinPrompt(scroller, shown);
    pinPrompt(scroller, hidden);
    await settle();
    intersections[0]!.callback([
        { target: shown.element, isIntersecting: true },
        { target: hidden.element, isIntersecting: false },
    ]);
    reads.rows = 0;
    hidden.said.length = 0;

    shown.box.top = 99;
    scroller.dispatchEvent(new Event(`scroll`));

    expect(shown.said.at(-1)).toBe(true);
    expect(hidden.said).toEqual([]);
    expect(reads.rows).toBe(1);
});

// Pinning collapses the prompt to one line, which shortens the transcript and drops the row by what it freed; below the
// edge by less than that, it is still the pinned one, or it would flip at frame rate at the foot of a turn.
it(`keeps a collapsed prompt pinned while it sits below the edge by less than its collapse freed`, async () => {
    const scroller = scrollerAt(100);
    const prompt = promptAt(scroller, { top: 90, height: 80 });
    pinPrompt(scroller, prompt);
    await settle();
    intersections[0]!.callback([{ target: prompt.element, isIntersecting: true }]);

    prompt.element.classList.add(`chat-prompt-pinned`);
    prompt.box.height = 30;
    prompt.box.top = 140;
    scroller.dispatchEvent(new Event(`scroll`));
    expect(prompt.said.at(-1)).toBe(true);

    prompt.box.top = 151;
    scroller.dispatchEvent(new Event(`scroll`));
    expect(prompt.said.at(-1)).toBe(false);
});

it(`remeasures when the content grows, and lets go of everything with its last prompt`, async () => {
    const scroller = scrollerAt(100);
    const prompt = promptAt(scroller, { top: 300, height: 40 });
    const release = pinPrompt(scroller, prompt);
    await settle();
    intersections[0]!.callback([{ target: prompt.element, isIntersecting: true }]);

    prompt.box.top = 50;
    resizes[0]!.callback([{ target: scroller.firstElementChild! }]);
    expect(prompt.said.at(-1)).toBe(true);

    release();
    expect(prompt.host.style.getPropertyValue(`--chat-pin`)).toBe(``);
    expect({ intersection: intersections[0]!.observed.size, resize: resizes[0]!.observed.size }).toEqual({ intersection: 0, resize: 0 });
    const before = prompt.said.length;
    scroller.dispatchEvent(new Event(`scroll`));
    expect(prompt.said).toHaveLength(before);
});
