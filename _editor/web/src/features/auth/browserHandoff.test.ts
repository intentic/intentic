import { effectScope } from "vue";
import { useBrowserHandoff } from "./browserHandoff";

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

test(`going back to the button ends the wait everywhere`, () => {
    const login = mounted();
    const wall = mounted();
    login.handoff.start();
    expect(wall.handoff.waiting.value).toBe(true);
    wall.handoff.cancel();
    expect(login.handoff.waiting.value).toBe(false);
});
