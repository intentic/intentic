// The outage screen. A reader who lands here has done nothing wrong and can do nothing useful, so the screen has to
// let go of them by itself the moment the platform answers — pressing the button is an offer, not the only way out.
import "@intentic/testing/dom";
import { it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";

const replace = mock();
mock.module(`vue-router`, () => ({
    ...actualVueRouter,
    useRouter: () => ({ replace }) as never,
    useRoute: () => ({ query: { returnTo: `/workspace` } }) as never,
}));

// The shared rule has its own suite (router/platformRetry.test.ts); here it only stands for "the platform answered".
const platformRetry = mock<() => Promise<string | undefined>>();
mock.module(`../../router/platformRetry`, () => ({ platformRetry: () => platformRetry() }));

const { default: PlatformUnavailable } = await import(`./PlatformUnavailable.vue`);

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(PlatformUnavailable) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await nextTick();
    return el;
};

const tryAgain = (el: HTMLElement): HTMLButtonElement => {
    const button = [...el.querySelectorAll(`button`)].find((entry) => entry.textContent?.includes(`Try again`));
    if (button === undefined) {
        throw new Error(`no retry button on the screen`);
    }
    return button;
};

// Long enough to cover the screen's own retry interval however it is tuned; the assertions are about whether it asks
// at all, not how often.
const A_WHILE_MS = 30_000;

beforeEach(() => {
    platformRetry.mockReset().mockResolvedValue(undefined);
    replace.mockReset();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
    jest.useRealTimers();
});

it(`takes the reader where they were headed once the platform answers`, async () => {
    const el = await mount();
    platformRetry.mockResolvedValue(`/workspace`);

    tryAgain(el).click();
    await nextTick();
    await Promise.resolve();

    expect(replace).toHaveBeenCalledWith(`/workspace`);
});

it(`stays put when the retry finds the platform still down`, async () => {
    const el = await mount();

    tryAgain(el).click();
    await nextTick();
    await Promise.resolve();

    expect(replace).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`Intentic isn't reachable`);
});

// The reason the screen can't just wait to be clicked: a reader who leaves the tab open expects to find the app back.
it(`keeps asking on its own while it is open`, async () => {
    jest.useFakeTimers();
    await mount();

    await advanceTimersByTimeAsync(A_WHILE_MS);

    // Repeatedly, not once: an outage the screen gave up on is the same trap as one it never asked about.
    expect(platformRetry.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it(`asks the moment the network comes back`, async () => {
    await mount();

    globalThis.dispatchEvent(new Event(`online`));
    await nextTick();

    expect(platformRetry).toHaveBeenCalledTimes(1);
});

// An interval outliving its screen would ask forever behind whatever the reader is looking at now.
it(`stops asking once it is gone`, async () => {
    jest.useFakeTimers();
    await mount();
    app?.unmount();
    app = undefined;
    platformRetry.mockClear();

    await advanceTimersByTimeAsync(A_WHILE_MS);
    globalThis.dispatchEvent(new Event(`online`));

    expect(platformRetry).not.toHaveBeenCalled();
});
