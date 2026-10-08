import "@intentic/testing/dom";
import { ref } from "vue";
import type { LocalFace } from "../app/environments/local";

/* Another folder in a desktop window's place, moved to without a reload: the app's offer is taken, the editor switches
   to the folder's "sandbox" and lands on its files, and the old page is held until the new one has drawn them. */

const LEFT: LocalFace = { daemonUrl: `http://127.0.0.1:4100`, token: `left`, id: `a`, name: `horus`, path: `/home/me/horus`, home: true };
const PICKED: LocalFace = { daemonUrl: `http://127.0.0.1:4100`, token: `picked`, id: `b`, name: `auto-translate`, path: `/home/me/auto-translate`, home: true };

const activeSandboxId = ref<string | undefined>(`local-a`);
// The platform answers with the face the window wears (desktop-app local/platform.ts), and the list selects it.
const lands = async (): Promise<void> => {
    activeSandboxId.value = `local-${window.__INTENTIC_LOCAL__?.id ?? ``}`;
};
const refresh = jest.fn(lands);
const landOnAfterSwitch = jest.fn();
const setPageTitle = jest.fn();

jest.mock("../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ activeSandboxId, refresh }) }));
jest.mock("../features/sandbox/switching/sandboxScreen", () => ({ landOnAfterSwitch }));
jest.mock("../shell/browser-tab/tabTitle", () => ({ setPageTitle }));

const { ARRIVAL_WAIT_MS, folderDrawn, moveTo, switchTo, takeFolderSwitches } = await import("./folderSwitch");

// Whether a promise has settled yet, without waiting on it.
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
    let done = false;
    void promise.then(
        () => (done = true),
        () => (done = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    return done;
};

beforeEach(() => {
    window.__INTENTIC_LOCAL__ = LEFT;
    activeSandboxId.value = `local-a`;
    refresh.mockImplementation(lands);
    refresh.mockClear();
    landOnAfterSwitch.mockClear();
    setPageTitle.mockClear();
});

afterEach(() => {
    jest.useRealTimers();
});

// As the app's local.rs `face_pointed` offers it: cancelable, the face as its detail.
const offer = (detail: unknown): boolean => !window.dispatchEvent(new CustomEvent(`intentic:repoint`, { cancelable: true, detail }));

describe(`the app's offer of another folder`, () => {
    it(`is taken while the shell takes switches, so the app does not reload the window`, async () => {
        const stop = takeFolderSwitches();
        expect(offer(PICKED)).toBe(true);
        // The switch it started, seen through: the folder drawn, and the editor on it.
        folderDrawn(`local-b`);
        for (let turn = 0; turn < 20 && activeSandboxId.value !== `local-b`; turn++) {
            await Promise.resolve();
        }
        expect(activeSandboxId.value).toBe(`local-b`);
        stop();
        // Once the shell is gone, nothing takes it, and the app reloads the window onto the folder instead.
        expect(offer(PICKED)).toBe(false);
    });

    it(`is left to the app when it is not a face this page can move to`, () => {
        const stop = takeFolderSwitches();
        expect(offer({ name: `half a face` })).toBe(false);
        stop();
    });
});

describe(`moving to the folder`, () => {
    it(`wears its face, names the page after it, lands on its files and selects its sandbox`, async () => {
        const moved = moveTo(PICKED);
        expect(window.__INTENTIC_LOCAL__).toEqual(PICKED);
        expect(setPageTitle).toHaveBeenCalledWith(`auto-translate`);
        expect(landOnAfterSwitch).toHaveBeenCalledWith(`local-b`, `/workspace`);
        folderDrawn(`local-b`);
        await moved;
        expect(activeSandboxId.value).toBe(`local-b`);
    });

    it(`holds until the folder's files are drawn, and a draw of any other folder is not that`, async () => {
        const moved = moveTo(PICKED);
        await Promise.resolve();
        folderDrawn(`local-a`);
        expect(await settled(moved)).toBe(false);
        folderDrawn(`local-b`);
        await moved;
    });

    it(`holds no longer than the wait, for a folder slow to draw`, async () => {
        jest.useFakeTimers();
        const moved = moveTo(PICKED);
        await Promise.resolve();
        expect(await settled(moved)).toBe(false);
        jest.advanceTimersByTime(ARRIVAL_WAIT_MS);
        await moved;
        expect(activeSandboxId.value).toBe(`local-b`);
    });

    it(`fails when the editor did not end up on the folder`, async () => {
        refresh.mockImplementation(async () => undefined);
        await expect(moveTo(PICKED)).rejects.toThrow(`local-b`);
    });
});

describe(`the whole switch`, () => {
    it(`runs the move inside a view transition, which holds the page as it stands until the move is done`, async () => {
        const update = jest.fn((callback: () => Promise<void>) => ({ updateCallbackDone: callback() }));
        Object.defineProperty(document, `startViewTransition`, { configurable: true, value: update });
        const switched = switchTo(PICKED);
        folderDrawn(`local-b`);
        await switched;
        expect(update).toHaveBeenCalledTimes(1);
        expect(activeSandboxId.value).toBe(`local-b`);
        Reflect.deleteProperty(document, `startViewTransition`);
    });

    it(`reloads onto the folder, on its files, when the move in place fails`, async () => {
        refresh.mockImplementation(async () => undefined);
        const reload = jest.fn();
        const replaceState = jest.spyOn(window.history, `replaceState`);
        const location = window.location;
        Object.defineProperty(window, `location`, { configurable: true, value: { pathname: `/files/local`, reload } });
        const quiet = jest.spyOn(console, `error`).mockImplementation(() => undefined);
        try {
            await switchTo(PICKED);
            expect(replaceState).toHaveBeenCalledWith(null, ``, `/files/local#/workspace`);
            expect(reload).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(window, `location`, { configurable: true, value: location });
            replaceState.mockRestore();
            quiet.mockRestore();
        }
    });
});
