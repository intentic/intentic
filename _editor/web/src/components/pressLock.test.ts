// @vitest-environment jsdom
//
// THE PRESS LOCK: what a control does between the click and the answer. Three surfaces, one state machine, so
// all three are pinned here rather than each proving its own half.
//
// The case that started it is the one at the bottom: two clicks 50ms apart on the same button used to send two
// requests, the second of which the daemon answered with a 404 because the first had already un-parked the
// turn, and the card put "the turn may have ended" on screen for a decision that had landed perfectly.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, withDirectives, type App } from "vue";
import { Button, vAction } from "@intentic/ui";
import { createPressLock, firePress, type PressState } from "@intentic/ui/press";

const MOUNTED: App[] = [];
let host: HTMLElement;

beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement(`div`);
    document.body.append(host);
});

afterEach(() => {
    MOUNTED.splice(0).forEach((app) => app.unmount());
    host.remove();
    vi.useRealTimers();
});

// A promise the test decides when to settle, standing in for a round trip.
const deferred = (): { promise: Promise<void>; settle: () => void } => {
    let settle = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
        settle = () => resolve();
    });
    return { promise, settle };
};

const mount = (render: () => unknown): HTMLElement => {
    const app = createApp({ render });
    app.directive(`action`, vAction);
    app.mount(host);
    MOUNTED.push(app);
    return host;
};

const button = (): HTMLButtonElement => {
    const found = host.querySelector(`button`);
    if (found === null) {
        throw new Error(`no button rendered`);
    }
    return found;
};

/* THE STATE MACHINE ------------------------------------------------------------------------------------- */

it(`locks in the same tick as the press, before anything is awaited`, () => {
    const states: PressState[] = [];
    const lock = createPressLock((state) => states.push({ ...state }));
    lock.hold(deferred().promise);
    // Not after a microtask, not on the next frame: the second click arrives ~50ms behind the first and has to
    // find a control that is already spoken for.
    expect(states).toEqual([{ locked: true, working: false }]);
});

it(`draws nothing for a wait short enough to read as instant`, async () => {
    const states: PressState[] = [];
    const lock = createPressLock((state) => states.push({ ...state }));
    const work = deferred();
    lock.hold(work.promise);
    work.settle();
    await vi.advanceTimersByTimeAsync(199);
    // A spinner shown for 40ms is a flinch, not information.
    expect(states.some((state) => state.working)).toBe(false);
    expect(states.at(-1)).toEqual({ locked: false, working: false });
});

it(`shows the wait once it outlives the reveal delay, and holds it long enough to be seen`, async () => {
    const states: PressState[] = [];
    const lock = createPressLock((state) => states.push({ ...state }));
    const work = deferred();
    lock.hold(work.promise);

    await vi.advanceTimersByTimeAsync(200);
    expect(states.at(-1)).toEqual({ locked: true, working: true });

    work.settle();
    await vi.advanceTimersByTimeAsync(10);
    // Still working, and still locked with it: a control that is visibly spinning must not answer a press.
    expect(states.at(-1)).toEqual({ locked: true, working: true });

    await vi.advanceTimersByTimeAsync(400);
    expect(states.at(-1)).toEqual({ locked: false, working: false });
});

it(`releases the lock when the work fails, so a retry is possible`, async () => {
    const states: PressState[] = [];
    const lock = createPressLock((state) => states.push({ ...state }));
    lock.hold(Promise.reject(new Error(`nope`)));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ locked: false, working: false });
});

it(`reports work from every handler a template stacked on one click, and none from a sync one`, () => {
    const work = deferred();
    expect(firePress(() => undefined, new Event(`click`))).toBeUndefined();
    expect(firePress([() => undefined, () => work.promise], new Event(`click`))).toBeInstanceOf(Promise);
});

/* THE BUTTON -------------------------------------------------------------------------------------------- */

it(`disables the button for as long as its handler is unfinished, and re-enables it after`, async () => {
    const work = deferred();
    mount(() => h(Button, { label: `Approve`, onClick: () => work.promise }));
    await nextTick();

    expect(button().disabled).toBe(false);
    button().click();
    await nextTick();
    expect(button().disabled).toBe(true);

    work.settle();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    expect(button().disabled).toBe(false);
});

it(`fires a slow handler once however many times it is clicked`, async () => {
    const work = deferred();
    let fired = 0;
    mount(() =>
        h(Button, {
            label: `Approve`,
            onClick: () => {
                fired += 1;
                return work.promise;
            },
        }),
    );
    await nextTick();

    button().click();
    await nextTick();
    button().click();
    button().click();
    await nextTick();

    expect(fired).toBe(1);
});

it(`leaves a synchronous button exactly as it was`, async () => {
    let fired = 0;
    mount(() => h(Button, { label: `Toggle`, onClick: () => (fired += 1) }));
    await nextTick();

    button().click();
    button().click();
    await nextTick();
    // Only actual waiting is drawn as waiting: a toggle stays a toggle.
    expect(fired).toBe(2);
    expect(button().disabled).toBe(false);
});

it(`hangs a spinner over a slot-bodied button once the wait is worth drawing, without resizing it`, async () => {
    const work = deferred();
    mount(() => h(Button, { onClick: () => work.promise }, { default: () => `Approve` }));
    await nextTick();

    button().click();
    await nextTick();
    // Pressed, but under the reveal delay: dimmed and locked, and nothing has moved.
    expect(host.querySelector(`.ui-press-spinner`)).toBeNull();
    expect(host.querySelector(`.invisible`)).toBeNull();

    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    expect(host.querySelector(`.ui-press-spinner`)).not.toBeNull();
    // The words are hidden, not removed: the button keeps the width it had, so answering one cannot reflow
    // the row of answers it sits in.
    expect(host.querySelector(`.invisible`)?.textContent).toBe(`Approve`);
});

it(`keeps the caller's own disabled state`, async () => {
    mount(() => h(Button, { label: `Save`, disabled: true, onClick: () => Promise.resolve() }));
    await nextTick();
    expect(button().disabled).toBe(true);
});

/* THE DIRECTIVE ----------------------------------------------------------------------------------------- */

it(`holds a hand-styled control the same way, and marks it busy for a screen reader`, async () => {
    const work = deferred();
    let fired = 0;
    // `withDirectives` rather than a template string: the runtime compiler is not in this build.
    mount(() =>
        withDirectives(h(`button`, `Sign out`), [
            [
                vAction,
                () => {
                    fired += 1;
                    return work.promise;
                },
            ],
        ]),
    );
    await nextTick();

    button().click();
    await nextTick();
    expect(button().dataset[`press`]).toBe(`locked`);
    expect(button().getAttribute(`aria-busy`)).toBe(`true`);

    button().click();
    button().click();
    expect(fired).toBe(1);

    work.settle();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    expect(button().dataset[`press`]).toBeUndefined();
    expect(button().getAttribute(`aria-busy`)).toBeNull();
});
