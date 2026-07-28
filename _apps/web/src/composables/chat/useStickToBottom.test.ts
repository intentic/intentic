// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type Ref } from "vue";
import { useStickToBottom } from "./useStickToBottom";

/* The follow rule, and the fact underneath it that has no other way of being stated: the observer that reports
 * the transcript growing belongs to the WINDOW its boxes live in. The chat panel is teleported into a real
 * pop-out window while its code stays in the opener, and an observer built in the opener is driven by the
 * opener's rendering loop — which a browser stops running for a window that is minimized, occluded or in a
 * background tab, i.e. the app window whenever the user is working in the chat window in front of it. The
 * symptom was a message sent from the pop-out landing below the fold with nothing to bring it up.
 *
 * jsdom lays nothing out and has no ResizeObserver, so both are stood in for: the geometry is the handful of
 * numbers the rule actually reads (and the clamp the browser applies to a scrollTop write), and the observer is
 * a recording stub installed per window — which is what makes "built by the right window" assertable at all. */

interface FakeObserver {
    readonly targets: Element[];
    readonly fire: () => void;
    disconnected: boolean;
}

// Hand a window a ResizeObserver whose instances are collected in order, so a test can say which window built
// the live one and fire the growth it would have reported.
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

// The panel, reduced to what the composable touches: the scroller, the content wrapper it measures, and the
// flag that says the two have been teleported to another document.
const mountPanel = (): { scroller: HTMLElement; poppedOut: Ref<boolean>; pin: () => void } => {
    const scroller = ref<HTMLElement>();
    const content = ref<HTMLElement>();
    const poppedOut = ref(false);
    let pin: () => void = () => {};
    const app = createApp({
        setup() {
            ({ pin } = useStickToBottom(scroller, content, poppedOut));
            return () => h(`div`, { ref: scroller }, [h(`div`, { ref: content })]);
        },
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    app.mount(host);
    return { scroller: scroller.value as HTMLElement, poppedOut, pin: () => pin() };
};

// A second window to be teleported into — an iframe is the one document jsdom gives with a defaultView of its
// own, which is the only thing the composable asks a pop-out window for.
const otherWindow = (): Window => {
    const frame = document.createElement(`iframe`);
    document.body.append(frame);
    return frame.contentWindow as Window;
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

it(`rebuilds the growth observer in the window the panel is teleported into`, async () => {
    const opener = installObserver(window);
    const { scroller, poppedOut } = mountPanel();
    const box = geometry(scroller, 1000, 400);
    await nextTick();
    expect(opener).toHaveLength(1);

    // What popping out does to the DOM: the panel is adopted by the pop-out document, elements and listeners
    // intact. Only the window behind them changed, and nothing about the elements says so.
    const popout = otherWindow();
    const popoutObservers = installObserver(popout);
    popout.document.body.append(scroller);
    poppedOut.value = true;
    await nextTick();

    expect((opener[0] as FakeObserver).disconnected).toBe(true);
    expect(popoutObservers).toHaveLength(1);
    // Both boxes again: the transcript growing, and the room it is read in shrinking.
    expect((popoutObservers[0] as FakeObserver).targets).toHaveLength(2);

    // The pop-out window's own report is what follows the transcript now — the opener's is gone, and in a real
    // browser it would have stopped being delivered the moment that window stopped painting.
    box.scrollHeight = 1400;
    (popoutObservers[0] as FakeObserver).fire();
    expect(scroller.scrollTop).toBe(1000);
});

it(`docks back onto the opener's window`, async () => {
    const opener = installObserver(window);
    const { scroller, poppedOut } = mountPanel();
    geometry(scroller, 1000, 400);
    await nextTick();

    const popout = otherWindow();
    installObserver(popout);
    popout.document.body.append(scroller);
    poppedOut.value = true;
    await nextTick();

    document.body.append(scroller); // the dock: usePopout salvages the nodes back into this document
    poppedOut.value = false;
    await nextTick();

    expect(opener).toHaveLength(2);
    expect((opener[1] as FakeObserver).disconnected).toBe(false);
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

it(`stops observing when the panel unmounts`, async () => {
    const observers = installObserver(window);
    const scroller = ref<HTMLElement>();
    const content = ref<HTMLElement>();
    const app = createApp({
        setup() {
            useStickToBottom(scroller, content, ref(false));
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
