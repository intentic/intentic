// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { useStickToBottom } from "./useStickToBottom";

/* The follow rule: a transcript stays at its newest content unless the reader has scrolled up.
 *
 * The observer that reports the transcript growing belongs to the window its boxes live in, which is a fact
 * with teeth only when those two can differ. They used to: a floating chat was DOM teleported into a second
 * window with its code left behind in the one that opened it, so the observer ran on a rendering loop the
 * browser had stopped handing out, and a message sent from the floating window landed below the fold with
 * nothing to bring it up. A floating panel is its own window now (composables/floating.ts), so the observer
 * and the boxes are in the same window by construction and there is nothing left to re-home on a move.
 *
 * jsdom lays nothing out and has no ResizeObserver, so both are stood in for: the geometry is the handful of
 * numbers the rule actually reads (and the clamp the browser applies to a scrollTop write), and the observer is
 * a recording stub. */

interface FakeObserver {
    readonly targets: Element[];
    readonly fire: () => void;
    disconnected: boolean;
}

// A ResizeObserver whose instances are collected in order, so a test can fire the growth one would have
// reported.
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

// The scroller's geometry as the rule sees it: a content height that can grow, a viewport height, and a
// scrollTop the browser clamps to the real maximum on write (the pin relies on reading that clamp back).
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

    const observed = observers[observers.length - 1] as FakeObserver;
    box.scrollHeight = 1400;
    observed.fire();
    expect(scroller.scrollTop).toBe(1000);

    // The user scrolls up to read: a move that went upward and landed away from the bottom, which is the only
    // thing that stops the follow.
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event(`scroll`));
    box.scrollHeight = 1800;
    observed.fire();
    expect(scroller.scrollTop).toBe(300);

    // Parking back at the bottom re-arms it, without anything having to say so.
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
    pin(); // submit(): the user wrote the newest thing in the transcript, so the bottom is where they want to be
    expect(scroller.scrollTop).toBe(600);
});

/* The panel's own report that the transcript changed, which exists because an observation can be lost: a
 * ResizeObserver notification the browser coalesces or defers past the growth that caused it left a just-sent
 * message and its "Perusing…" loader below the fold with nothing to bring them up. Growth with NO observation
 * at all is what that failure looks like from here. */
it(`follows a transcript that changed without the observer reporting it`, async () => {
    installObserver(window);
    const { scroller, follow } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();

    box.scrollHeight = 1400; // the sent message and the loader under it, unobserved
    follow();
    expect(scroller.scrollTop).toBe(1000);

    // Still nobody else's turn to be moved: a reader who scrolled up stays where they are, observed or not.
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
