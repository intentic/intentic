// The outage screen. A reader who lands here has done nothing wrong and can do nothing useful, so the screen has to
// let go of them by itself the moment the platform answers — pressing the button is an offer, not the only way out.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync, stubGlobal, unstubAllGlobals, waitFor } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";
import * as actualThisComputer from "../../../app/environments/thisComputer";

const replace = jest.fn();
// Where the reader was headed; an /open link to a sandbox lands here carrying its address.
const query = { returnTo: `/workspace` };
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRouter: () => ({ replace }) as never,
    useRoute: () => ({ query }) as never,
}));

// The shared rule has its own suite (client/auth/platformRetry.test.ts); here it only stands for "the platform answered".
const platformRetry = jest.fn<() => Promise<string | undefined>>();
jest.mock(`../../../client/auth/platformRetry`, () => ({ platformRetry: () => platformRetry() }));
// Whether the app offers this computer's sandboxes is the real module's reading of the window; only the press is watched.
const openedThisComputer = jest.fn();
jest.mock(`../../../app/environments/thisComputer`, () => ({ ...actualThisComputer, openThisComputersSandboxes: () => openedThisComputer() }));

const { default: PlatformUnavailable } = await import(`../PlatformUnavailable.vue`);
// The same module instances the screen reads, to give the device something to remember and to see what opened.
const { forgetAccount, rememberListed } = await import(`../../../client/directory/deviceDirectory`);
const { directMode } = await import(`../../../client/directory/directState`);
const { useSandbox } = await import(`../../../client/sandbox/useSandbox`);
const { sandboxSummary } = await import(`../../../testing/sandboxSummary`);

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

const owner = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };

beforeEach(() => {
    platformRetry.mockReset().mockResolvedValue(undefined);
    replace.mockReset();
    query.returnTo = `/workspace`;
    forgetAccount(owner.email);
    directMode.value = false;
    openedThisComputer.mockReset();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
    jest.useRealTimers();
    unstubAllGlobals();
    Reflect.deleteProperty(window, `__INTENTIC_DESKTOP__`);
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
    expect(el.textContent).toContain(`Intentic isn't answering`);
});

// Intentic being down is not the reader's connection: the screen says whose servers are not answering, and that the
// sandboxes themselves are fine.
it(`says Intentic's servers are not answering, not the reader's connection`, async () => {
    const el = await mount();
    expect(el.textContent).toContain(`Intentic's servers aren't answering right now. Your sign-in is unchanged and your sandboxes keep running`);
    expect(el.textContent).not.toContain(`Check your connection`);
});

// In the desktop app on a computer that runs sandboxes, those open without Intentic (app/environments/thisComputer.ts).
describe(`this computer's own sandboxes`, () => {
    const asApp = (desktop: Record<string, unknown>): void => {
        // Set as the app injects it, with fields this build's type does not name yet.
        Reflect.set(window, `__INTENTIC_DESKTOP__`, { version: `1.361.0`, installId: `i-1`, update: null, ...desktop });
    };
    const useThisComputer = (el: HTMLElement): HTMLButtonElement | undefined =>
        [...el.querySelectorAll(`button`)].find((entry) => entry.textContent?.trim() === `Use this computer's sandboxes`);

    it(`are offered where the app says it can open them, and a press asks the app to`, async () => {
        asApp({ machineFace: true });
        const el = await mount();
        expect(el.textContent).toContain(`The sandboxes running on this computer open without Intentic.`);

        useThisComputer(el)!.click();

        expect(openedThisComputer).toHaveBeenCalledTimes(1);
        // The way back stays beside it.
        expect(tryAgain(el).textContent?.trim()).toBe(`Try again`);
    });

    it(`are not offered in a browser, nor by an app that does not say it can open them`, async () => {
        const inBrowser = await mount();
        expect(useThisComputer(inBrowser)).toBeUndefined();
        app?.unmount();
        document.body.replaceChildren();

        asApp({});
        const olderApp = await mount();
        expect(useThisComputer(olderApp)).toBeUndefined();
        expect(olderApp.textContent).not.toContain(`open without Intentic`);
    });
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

// What still works while the platform is down: the sandboxes themselves, opened without it (recovery/directMode.ts).
describe(`the sandboxes this device remembers`, () => {
    const intentic = sandboxSummary({ id: `s1`, name: `intentic`, daemonUrl: `https://sandbox-82789f4106b4.radarsu.com`, lastSeenAt: `2026-10-01T18:00:09.479Z` });
    const answering = () => stubGlobal(`fetch`, async () => new Response(JSON.stringify({ ok: true, sandboxId: `82789f4106b4` }), { status: 200 }));
    const openButton = (el: HTMLElement): HTMLButtonElement | undefined => [...el.querySelectorAll(`button`)].find((entry) => entry.textContent?.trim() === `Open`);

    it(`offers nothing on a device that remembers nothing`, async () => {
        const el = await mount();
        expect(el.textContent).not.toContain(`Your sandboxes on this device`);
    });

    it(`lists them, checks each from this browser, and opens one without the platform`, async () => {
        answering();
        rememberListed(owner, [intentic], `id-1`);
        const el = await mount();
        expect(el.textContent).toContain(`Your sandboxes on this device`);
        await waitFor(() => expect(el.textContent).toContain(`sandbox-82789f4106b4.radarsu.com · Answering`));

        openButton(el)!.click();
        await waitFor(() => expect(replace).toHaveBeenCalledWith(`/`));
        expect(directMode.value).toBe(true);
        expect(useSandbox().activeSandboxId.value).toBe(`s1`);
    });

    it(`offers the sandbox an /open link named first, by its host when the device never listed it`, async () => {
        answering();
        rememberListed(owner, [intentic], `id-1`);
        query.returnTo = `/open?url=${encodeURIComponent(`https://sandbox-8a8171848c91.sbx.intentic.dev/`)}`;
        const el = await mount();
        const first = el.querySelector(`li`);
        expect(first?.textContent).toContain(`sandbox-8a8171848c91.sbx.intentic.dev`);
        expect(first?.textContent).toContain(`The sandbox you opened`);
        expect(el.querySelectorAll(`li`)).toHaveLength(2);
    });
});
