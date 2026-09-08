// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { useStickToBottom } from "./useStickToBottom";

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
const mountPanel = (): { scroller: HTMLElement; pin: () => void; follow: () => void } => {
    const scroller = ref<HTMLElement>();
    const content = ref<HTMLElement>();
    let pin: () => void = () => {};
    let follow: () => void = () => {};
    const app = createApp({
        setup() {
            ({ pin, follow } = useStickToBottom(scroller, content));
            return () => h(`div`, { ref: scroller }, [h(`div`, { ref: content })]);
        },
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    app.mount(host);
    return { scroller: scroller.value as HTMLElement, pin: () => pin(), follow: () => follow() };
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
    const scroller = ref<HTMLElement>();
    const content = ref<HTMLElement>();
    const app = createApp({
        setup() {
            useStickToBottom(scroller, content);
            return () => h(`div`, { ref: scroller }, [h(`div`, { ref: content })]);
        },
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    app.mount(host);
    const element = scroller.value as HTMLElement;
    const remove = vi.spyOn(element, `removeEventListener`);
    await nextTick();

    app.unmount();

    expect((observers[0] as FakeObserver).disconnected).toBe(true);
    expect(remove).toHaveBeenCalledWith(`scroll`, expect.any(Function));
});
