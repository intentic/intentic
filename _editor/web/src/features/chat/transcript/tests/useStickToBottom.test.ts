import "@intentic/testing/dom";
import { createApp, h, nextTick, type Ref, ref } from "vue";
import { type TranscriptHold, useStickToBottom } from "../useStickToBottom";

// Pins the follow rule: stays at newest content unless the reader has scrolled up. Needs jsdom stand-ins for layout and
// ResizeObserver, both faked here.

interface FakeObserver {
    readonly targets: Element[];
    readonly fire: () => void;
    disconnected: boolean;
}

// Fake ResizeObserver whose instances are collected in order, so a test can fire the growth it would report.
const installObserver = (win: Window): FakeObserver[] => {
    const made: FakeObserver[] = [];
    class Recording {
        private readonly self: FakeObserver;
        constructor(callback: () => void) {
            this.self = { targets: [], fire: callback, disconnected: false };
            made.push(this.self);
        }
        observe(target: Element): void {
            this.self.targets.push(target);
        }
        unobserve(): void {}
        disconnect(): void {
            this.self.disconnected = true;
        }
    }
    (win as unknown as { ResizeObserver: unknown }).ResizeObserver = Recording;
    return made;
};

// Scroller geometry the rule reads: content height, viewport height, and a scrollTop clamped on write.
const geometry = (element: HTMLElement, scrollHeight: number, clientHeight: number) => {
    const box = { scrollHeight, clientHeight, top: 0 };
    Object.defineProperty(element, `scrollHeight`, { get: () => box.scrollHeight });
    Object.defineProperty(element, `clientHeight`, { get: () => box.clientHeight });
    Object.defineProperty(element, `scrollTop`, {
        get: () => box.top,
        set: (value: number) => {
            box.top = Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight));
        },
    });
    return box;
};

// The panel, reduced to what the composable touches: the scroller and the content wrapper it measures.
const mountPanel = (): { scroller: HTMLElement; pin: () => void; follow: () => void; hold: TranscriptHold; parked: () => boolean } => {
    const scroller = ref<HTMLElement | null>(null);
    const content = ref<HTMLElement | null>(null);
    let pin: () => void = () => {};
    let follow: () => void = () => {};
    let hold: TranscriptHold = (_element, change) => change();
    let parked: Readonly<Ref<boolean>> = ref(true);
    const app = createApp({
        setup() {
            ({ pin, follow, hold, parked } = useStickToBottom(scroller, content));
            return () => h(`div`, { ref: scroller }, [h(`div`, { ref: content })]);
        },
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    app.mount(host);
    return {
        scroller: scroller.value as HTMLElement,
        pin: () => pin(),
        follow: () => follow(),
        hold: (element, change) => hold(element, change),
        parked: () => parked.value,
    };
};

it(`follows growth while parked at the bottom, and leaves a reader who scrolled up alone`, async () => {
    const observers = installObserver(window);
    const { scroller } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();

    const observed = observers.at(-1) as FakeObserver;
    box.scrollHeight = 1400;
    observed.fire();
    expect(scroller.scrollTop).toBe(1000);

    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event(`scroll`));
    box.scrollHeight = 1800;
    observed.fire();
    expect(scroller.scrollTop).toBe(300);

    scroller.scrollTop = 1400;
    scroller.dispatchEvent(new Event(`scroll`));
    box.scrollHeight = 2200;
    observed.fire();
    expect(scroller.scrollTop).toBe(1800);
});

// What the row window reads (paneWindow.ts): it takes rows above it down only while this says the reader is at the newest.
it(`says whether the reader is at the newest, as they leave it and come back`, async () => {
    installObserver(window);
    const { scroller, parked, pin } = mountPanel();
    geometry(scroller, 1000, 400);
    await nextTick();
    pin();
    expect(parked()).toBe(true);

    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event(`scroll`));
    expect(parked()).toBe(false);

    scroller.scrollTop = 600;
    scroller.dispatchEvent(new Event(`scroll`));
    expect(parked()).toBe(true);
});

it(`sends the transcript to its newest message when the panel asks`, async () => {
    installObserver(window);
    const { scroller, pin } = mountPanel();
    geometry(scroller, 1000, 400);
    await nextTick();

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event(`scroll`));
    pin();
    expect(scroller.scrollTop).toBe(600);
});

// Panel-driven follow, for growth the observer can miss entirely (coalesced or deferred).
it(`follows a transcript that changed without the observer reporting it`, async () => {
    installObserver(window);
    const { scroller, follow } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();

    box.scrollHeight = 1400;
    follow();
    expect(scroller.scrollTop).toBe(1000);

    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event(`scroll`));
    box.scrollHeight = 1800;
    follow();
    expect(scroller.scrollTop).toBe(300);
});

it(`stops observing when the panel unmounts`, async () => {
    const observers = installObserver(window);
    const scroller = ref<HTMLElement | null>(null);
    const content = ref<HTMLElement | null>(null);
    const app = createApp({
        setup() {
            useStickToBottom(scroller, content);
            return () => h(`div`, { ref: scroller }, [h(`div`, { ref: content })]);
        },
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    // Every listener the scroller is given, with the signal that takes it off.
    const added: { type: string; signal: AbortSignal | undefined }[] = [];
    const add = HTMLElement.prototype.addEventListener;
    const spy = jest
        .spyOn(HTMLElement.prototype, `addEventListener`)
        .mockImplementation(function (this: HTMLElement, type: string, listener: EventListener, options?: AddEventListenerOptions) {
            added.push({ type, signal: options?.signal });
            add.call(this, type, listener, options);
        });
    app.mount(host);
    spy.mockRestore();
    await nextTick();

    app.unmount();

    expect((observers[0] as FakeObserver).disconnected).toBe(true);
    expect(added.map(({ type }) => type)).toEqual(expect.arrayContaining([`scroll`, `wheel`, `touchstart`, `touchmove`, `touchend`]));
    expect(added.every(({ signal }) => signal?.aborted === true)).toBe(true);
});

// A soft wheel notch up from the bottom lands inside the parked threshold; the next layout change (a row realizing as it
// scrolls into view, a streamed token) must not drag the reader back down.
it(`leaves a reader who scrolled up a little alone`, async () => {
    const observers = installObserver(window);
    const { scroller } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();
    const observed = observers.at(-1) as FakeObserver;
    observed.fire();
    expect(scroller.scrollTop).toBe(600);

    scroller.scrollTop = 560;
    scroller.dispatchEvent(new Event(`scroll`));
    box.scrollHeight = 1010;
    observed.fire();
    expect(scroller.scrollTop).toBe(560);

    // Back down to the bottom re-parks it.
    scroller.scrollTop = 610;
    scroller.dispatchEvent(new Event(`scroll`));
    box.scrollHeight = 1100;
    observed.fire();
    expect(scroller.scrollTop).toBe(700);
});

// Content shrinking under a parked reader clamps scrollTop upward; that is layout, not the reader leaving.
it(`stays parked when the content shrinks under it`, async () => {
    const observers = installObserver(window);
    const { scroller } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();
    const observed = observers.at(-1) as FakeObserver;
    observed.fire();

    const beforeShrink = scroller.scrollTop;
    box.scrollHeight = 800;
    scroller.scrollTop = beforeShrink;
    scroller.dispatchEvent(new Event(`scroll`));
    box.scrollHeight = 1200;
    observed.fire();
    expect(scroller.scrollTop).toBe(800);
});

// Wheel intent unpins even when the same frame's reflow reshaped the content.
it(`leaves a reader who wheeled up while the content reflowed`, async () => {
    const observers = installObserver(window);
    const { scroller } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();
    const observed = observers.at(-1) as FakeObserver;
    observed.fire();

    scroller.dispatchEvent(new WheelEvent(`wheel`, { deltaY: -30 }));
    scroller.scrollTop = 570;
    box.scrollHeight = 1020;
    scroller.dispatchEvent(new Event(`scroll`));
    observed.fire();
    expect(scroller.scrollTop).toBe(570);
});

// The observer the panel made last, the one a test fires.
const newest = (observers: FakeObserver[]): FakeObserver => {
    const observer = observers.at(-1);
    if (observer === undefined) {
        throw new Error(`no observer was made`);
    }
    return observer;
};

// A row in the transcript at `offset` from the content's top: where it stands on screen follows the scroller.
const rowAt = (scroller: HTMLElement, offset: number): HTMLElement => {
    const row = document.createElement(`button`);
    scroller.append(row);
    row.getBoundingClientRect = () => new DOMRect(0, offset - scroller.scrollTop, 0, 0);
    return row;
};

// A fold the reader opens grows the content exactly as a streamed message does; only the press can say which it was.
it(`keeps a fold the reader opened at the bottom where it stood, and stops following`, async () => {
    const observers = installObserver(window);
    const { scroller, hold, parked } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();
    const observed = newest(observers);
    observed.fire();
    const header = rowAt(scroller, 900);
    expect(header.getBoundingClientRect().top).toBe(300);

    hold(header, () => {
        box.scrollHeight = 1600;
    });
    await nextTick();
    observed.fire();
    expect(header.getBoundingClientRect().top).toBe(300);
    expect(parked()).toBe(false);

    // Reading what opened, the reader is not dragged on by the stream either, until they scroll back to the newest.
    box.scrollHeight = 1700;
    observed.fire();
    expect(scroller.scrollTop).toBe(600);
    scroller.scrollTop = 1300;
    scroller.dispatchEvent(new Event(`scroll`));
    expect(parked()).toBe(true);
});

// Shutting a fold at the bottom: the content shrinks under the reader, who is left at the newest and follows it on.
it(`follows on after the reader shuts a fold at the bottom`, async () => {
    const observers = installObserver(window);
    const { scroller, hold, parked } = mountPanel();
    const box = geometry(scroller, 1400, 400);
    await nextTick();
    const observed = newest(observers);
    observed.fire();
    const header = rowAt(scroller, 1100);

    hold(header, () => {
        box.scrollHeight = 1000;
        box.top = Math.min(box.top, 600);
    });
    await nextTick();
    expect(parked()).toBe(true);
    box.scrollHeight = 1100;
    observed.fire();
    expect(scroller.scrollTop).toBe(700);
});

// A finger's drag carries the same intent a wheel does (TouchEvent's touch list, reduced to what the rule reads).
const touch = (scroller: HTMLElement, type: string, ...ys: number[]): void => {
    const event = new Event(type);
    Object.defineProperty(event, `touches`, { value: ys.map((clientY) => ({ clientY })) });
    scroller.dispatchEvent(event);
};

// While a stream reshapes the content between every scroll event, the drag's own scrolls read as clamping; the finger
// says what they are.
it(`leaves a reader who dragged up while the stream reshaped the content`, async () => {
    const observers = installObserver(window);
    const { scroller, parked } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();
    const observed = newest(observers);
    observed.fire();

    touch(scroller, `touchstart`, 300);
    for (let step = 1; step <= 5; step += 1) {
        box.scrollHeight += 50;
        touch(scroller, `touchmove`, 300 + step * 20);
        scroller.scrollTop -= 20;
        scroller.dispatchEvent(new Event(`scroll`));
        observed.fire();
    }
    touch(scroller, `touchend`);
    observed.fire();
    expect(scroller.scrollTop).toBe(500);
    expect(parked()).toBe(false);
});

it(`pins nothing under a finger, and catches up once it lifts`, async () => {
    const observers = installObserver(window);
    const { scroller } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();
    const observed = newest(observers);
    observed.fire();

    touch(scroller, `touchstart`, 300);
    box.scrollHeight = 1200;
    observed.fire();
    expect(scroller.scrollTop).toBe(600);

    touch(scroller, `touchend`);
    expect(scroller.scrollTop).toBe(800);
});
