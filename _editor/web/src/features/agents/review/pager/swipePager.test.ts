import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, ref } from "vue";
import { useMotion } from "@intentic/ui/motion";
import SwipePages from "./SwipePages.vue";
import { swipeBelongsElsewhere } from "./swipeYields";

// Pins what a thumb does to a phone's agent pages: a swipe across past the line turns to the neighbour, short of it
// springs back, and the turn leaves the page out of view hidden and inert. What it never does: answer a scroll, a touch
// from the left edge (the way back), a drag that starts in something that moves sideways itself, or a swipe off the
// end. Motion is off, so every glide lands at once and the test reads where the pages end up.

const WIDTH = 300;

interface Point {
    readonly x: number;
    readonly y: number;
}

// A touch list as the gesture reads one: indexed, counted, and searched by identifier.
const touchList = (points: readonly (Point & { target: EventTarget })[]): TouchList => {
    const touches = points.map((point) => ({ identifier: 1, clientX: point.x, clientY: point.y, target: point.target }));
    return Object.assign(touches, { item: (i: number) => touches[i] ?? null }) as unknown as TouchList;
};

let clock = 1_000;
const touch = (el: Element, type: string, point: Point, at = (clock += 16)): void => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const down = type === `touchend` || type === `touchcancel` ? [] : [{ ...point, target: el }];
    Object.defineProperties(event, {
        touches: { value: touchList(down) },
        changedTouches: { value: touchList([{ ...point, target: el }]) },
        timeStamp: { value: at },
    });
    el.dispatchEvent(event);
};

// A drag from `from` by (dx, dy), in steps, then a release. `hold` waits before letting go, so the release has no speed.
const drag = async (el: Element, dx: number, dy = 0, from: Point = { x: 200, y: 300 }, hold = false): Promise<void> => {
    touch(el, `touchstart`, from);
    for (let step = 1; step <= 4; step += 1) {
        touch(el, `touchmove`, { x: from.x + (dx * step) / 4, y: from.y + (dy * step) / 4 });
    }
    const end = { x: from.x + dx, y: from.y + dy };
    touch(el, `touchend`, end, hold ? (clock += 200) : (clock += 16));
    await nextTick();
};

describe(`a phone's agent pages`, () => {
    let app: App | undefined;
    let host: HTMLElement;
    const page = ref<`chat` | `changes`>(`chat`);
    const pages = ref<readonly (`chat` | `changes`)[]>([`chat`, `changes`]);

    const mount = async (): Promise<{ chat: HTMLElement; changes: () => HTMLElement | null; inChat: HTMLElement }> => {
        host = document.createElement(`div`);
        document.body.append(host);
        app = createApp({
            render: () =>
                h(
                    SwipePages,
                    {
                        pages: pages.value,
                        modelValue: page.value,
                        "onUpdate:modelValue": (value: string) => (page.value = value === `changes` ? `changes` : `chat`),
                        idPrefix: `p`,
                    },
                    {
                        chat: () =>
                            h(`div`, { class: `transcript` }, [
                                h(`p`, { class: `line` }, `A line`),
                                h(`pre`, { class: `wide`, style: `overflow-x: auto` }, `const wide = true;`),
                                h(`textarea`),
                                h(`div`, { "data-own-swipe": `` }, [h(`span`, { class: `owned` }, `diff`)]),
                            ]),
                        changes: () => h(`div`, `Changes`),
                    },
                ),
        });
        app.mount(host);
        await nextTick();
        const surface = host.firstElementChild as HTMLElement;
        Object.defineProperty(surface, `clientWidth`, { configurable: true, get: () => WIDTH });
        return {
            chat: host.querySelector(`#p-chat`) as HTMLElement,
            changes: () => host.querySelector(`#p-changes`),
            inChat: host.querySelector(`.line`) as HTMLElement,
        };
    };

    beforeEach(() => {
        page.value = `chat`;
        pages.value = [`chat`, `changes`];
        useMotion().setMotion(`off`);
        stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback) => {
            // Drawn at once, inside the move that asked: 0, so the pager never thinks a frame is still pending.
            callback(0);
            return 0;
        });
    });

    afterEach(() => {
        app?.unmount();
        app = undefined;
        host.remove();
        unstubAllGlobals();
        useMotion().setMotion(`system`);
        document.getSelection()?.removeAllRanges();
    });

    it(`rests on the chat with the changes page hidden beside it, and inert`, async () => {
        const { chat, changes } = await mount();
        expect(chat.style.transform).toBe(``);
        expect(changes()?.style.transform).toBe(`translate3d(100%, 0, 0)`);
        expect(changes()?.style.visibility).toBe(`hidden`);
        expect(changes()?.hasAttribute(`inert`)).toBe(true);
        expect(chat.hasAttribute(`inert`)).toBe(false);
    });

    it(`turns to the changes past the line, and back again the other way`, async () => {
        const { chat, changes, inChat } = await mount();
        await drag(inChat, -200);
        expect(page.value).toBe(`changes`);
        expect(chat.style.transform).toBe(`translate3d(-100%, 0, 0)`);
        expect(chat.style.visibility).toBe(`hidden`);
        expect(changes()?.style.transform).toBe(``);
        expect(chat.hasAttribute(`inert`)).toBe(true);
        await drag(changes()!, 200);
        expect(page.value).toBe(`chat`);
        expect(chat.style.transform).toBe(``);
    });

    it(`follows the finger, and springs back from a slow release short of the line`, async () => {
        const { chat, changes, inChat } = await mount();
        touch(inChat, `touchstart`, { x: 200, y: 300 });
        touch(inChat, `touchmove`, { x: 170, y: 300 });
        touch(inChat, `touchmove`, { x: 140, y: 300 });
        // Both pages drawn mid-move, each at its distance from the finger.
        expect(chat.style.transform).toBe(`translate3d(-20%, 0, 0)`);
        expect(changes()?.style.transform).toBe(`translate3d(80%, 0, 0)`);
        expect(changes()?.style.visibility).toBe(``);
        touch(inChat, `touchend`, { x: 140, y: 300 }, (clock += 200));
        await nextTick();
        expect(page.value).toBe(`chat`);
        expect(chat.style.transform).toBe(``);
        expect(changes()?.style.visibility).toBe(`hidden`);
    });

    it(`turns on a flick well short of the line`, async () => {
        const { inChat } = await mount();
        await drag(inChat, -60);
        expect(page.value).toBe(`changes`);
    });

    it(`leaves a scroll, the left edge, and a swipe off the end alone`, async () => {
        const { chat, inChat } = await mount();
        await drag(inChat, -20, 200);
        await drag(inChat, -200, 0, { x: 12, y: 300 });
        expect(page.value).toBe(`chat`);
        // Off the first page's own end: stretched under the finger, never turned.
        touch(inChat, `touchstart`, { x: 100, y: 300 });
        touch(inChat, `touchmove`, { x: 250, y: 300 });
        expect(chat.style.transform).not.toBe(``);
        touch(inChat, `touchend`, { x: 250, y: 300 });
        await nextTick();
        expect(page.value).toBe(`chat`);
        expect(chat.style.transform).toBe(``);
    });

    it(`leaves a sideways drag to whatever moves sideways itself`, async () => {
        const { inChat } = await mount();
        const wide = host.querySelector(`.wide`) as HTMLElement;
        Object.defineProperty(wide, `scrollWidth`, { configurable: true, get: () => 900 });
        Object.defineProperty(wide, `clientWidth`, { configurable: true, get: () => WIDTH });
        await drag(wide, -200);
        await drag(host.querySelector(`textarea`)!, -200);
        await drag(host.querySelector(`.owned`)!, -200);
        expect(page.value).toBe(`chat`);
        // And the transcript around them still turns.
        await drag(inChat, -200);
        expect(page.value).toBe(`changes`);
    });

    it(`slides when the page is chosen from outside, and stays put with only one page`, async () => {
        const { chat, changes, inChat } = await mount();
        page.value = `changes`;
        await nextTick();
        await nextTick();
        expect(chat.style.transform).toBe(`translate3d(-100%, 0, 0)`);
        expect(changes()?.style.transform).toBe(``);
        page.value = `chat`;
        pages.value = [`chat`];
        await nextTick();
        await nextTick();
        expect(changes()).toBeNull();
        await drag(inChat, -200);
        expect(page.value).toBe(`chat`);
        expect(chat.style.transform).toBe(``);
    });
});

describe(`whose sideways touch it is`, () => {
    let root: HTMLElement;

    beforeEach(() => {
        root = document.createElement(`div`);
        document.body.append(root);
    });

    afterEach(() => {
        root.remove();
        document.getSelection()?.removeAllRanges();
    });

    const inside = (html: string, pick: string): Element => {
        root.innerHTML = html;
        return root.querySelector(pick)!;
    };

    it(`is the pager's on ordinary content`, () => {
        expect(swipeBelongsElsewhere(inside(`<div><p>text</p></div>`, `p`), root)).toBe(false);
        expect(swipeBelongsElsewhere(inside(`<pre style="overflow-x: auto">short</pre>`, `pre`), root)).toBe(false);
    });

    it(`is a typing surface's, a slider's and a marked subtree's`, () => {
        expect(swipeBelongsElsewhere(inside(`<input />`, `input`), root)).toBe(true);
        expect(swipeBelongsElsewhere(inside(`<div contenteditable="true"><b>x</b></div>`, `b`), root)).toBe(true);
        expect(swipeBelongsElsewhere(inside(`<div role="slider"><i>x</i></div>`, `i`), root)).toBe(true);
        expect(swipeBelongsElsewhere(inside(`<section data-own-swipe><p>diff</p></section>`, `p`), root)).toBe(true);
    });

    it(`is a sideways scroller's while it overflows`, () => {
        const code = inside(`<pre style="overflow-x: auto"><code>long</code></pre>`, `code`);
        const pre = root.querySelector(`pre`)!;
        Object.defineProperty(pre, `scrollWidth`, { configurable: true, get: () => 900 });
        Object.defineProperty(pre, `clientWidth`, { configurable: true, get: () => 300 });
        expect(swipeBelongsElsewhere(code, root)).toBe(true);
    });

    it(`stops at the pager: what holds the pager is not asked`, () => {
        root.setAttribute(`data-own-swipe`, ``);
        expect(swipeBelongsElsewhere(inside(`<p>text</p>`, `p`), root)).toBe(false);
    });

    it(`is a selection's while one is being made`, () => {
        const p = inside(`<p>select me</p>`, `p`);
        const range = document.createRange();
        range.selectNodeContents(p);
        document.getSelection()?.addRange(range);
        expect(swipeBelongsElsewhere(p, root)).toBe(true);
    });
});
