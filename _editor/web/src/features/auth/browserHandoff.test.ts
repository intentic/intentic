import "@intentic/testing/dom";
import { effectScope } from "vue";
import { takeBrowserHandoffDestination, useBrowserHandoff, WAITING_LONG_MS } from "./browserHandoff";

// The desktop window's wait for a sign-in in the browser belongs to the window: a sign-in page drawn again while the
// browser has it still says so, rather than offering the button a second time.

const signInThroughBrowser = jest.fn();
jest.mock(`../../app/environments/desktop`, () => ({ signInThroughBrowser: () => signInThroughBrowser() }));

const mounted = () => {
    const scope = effectScope();
    const handoff = scope.run(() => useBrowserHandoff())!;
    return { handoff, unmount: () => scope.stop() };
};

afterEach(() => {
    useBrowserHandoff().cancel();
    takeBrowserHandoffDestination();
    signInThroughBrowser.mockClear();
});

test(`a sign-in page drawn again while the browser has the sign-in still waits for it`, () => {
    const first = mounted();
    first.handoff.start();
    expect(signInThroughBrowser).toHaveBeenCalledTimes(1);
    first.unmount();

    const again = mounted();
    expect(again.handoff.waiting.value).toBe(true);
    again.unmount();
});

test(`returns to the requested dialog after the browser handoff, only once`, () => {
    const login = mounted();

    login.handoff.start(`/home?add=sandbox`);

    expect(takeBrowserHandoffDestination()).toBe(`/home?add=sandbox`);
    expect(takeBrowserHandoffDestination()).toBe(`/`);
});

test(`does not carry an off-origin destination through the handoff`, () => {
    const login = mounted();

    login.handoff.start(`//evil.example`);

    expect(takeBrowserHandoffDestination()).toBe(`/`);
});

test(`going back to the button ends the wait everywhere`, () => {
    const login = mounted();
    const wall = mounted();
    login.handoff.start();
    expect(wall.handoff.waiting.value).toBe(true);
    wall.handoff.cancel();
    expect(login.handoff.waiting.value).toBe(false);
});

// A wait that runs long may never end by itself (a browser that would not launch the app again), so the dialog points
// at its emailed code; the beat goes with the wait.
test(`a long wait says so, and going back to the button takes it down`, () => {
    jest.useFakeTimers();
    try {
        const login = mounted();
        login.handoff.start();
        jest.advanceTimersByTime(WAITING_LONG_MS - 1);
        expect(login.handoff.waitingLong.value).toBe(false);
        jest.advanceTimersByTime(1);
        expect(login.handoff.waitingLong.value).toBe(true);
        login.handoff.cancel();
        expect(login.handoff.waitingLong.value).toBe(false);

        // Called off before it ran long: nothing is raised later.
        login.handoff.start();
        login.handoff.cancel();
        jest.advanceTimersByTime(WAITING_LONG_MS);
        expect(login.handoff.waitingLong.value).toBe(false);
    } finally {
        jest.useRealTimers();
    }
});
