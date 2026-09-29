import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, nextTick } from "vue";
import { externalDirtyPaths, setExternalDirty } from "../features/workspace/files/externalDirty";
import { useEditBuffers } from "../features/workspace/files/useEditBuffers";
import { useWorkspaceTabs } from "../features/workspace/tabs/useWorkspaceTabs";
import { useUnsavedGuard } from "./useUnsavedGuard";

// Pins a local window's side of the app's close guard: the app hears every turn from clean to dirty and back, and a
// close it held back is answered by the page, at once when nothing is unsaved and only on the reader's word otherwise.

const DIRTY = `intentic://window?do=dirty&value=1`;
const CLEAN = `intentic://window?do=dirty&value=0`;
const CLOSE = `intentic://window?do=close&confirmed=1`;

// Every link the page follows, in order: a window of the app, whose page has finished loading. Links leave one at a
// time, a beat apart (desktop.ts `openDesktopLink`), so the clock is faked and walked past the gaps before anything
// the app heard is read: `handed()` is what it has heard by then.
let heard: string[] = [];
const LINK_GAP_WALK_MS = 1_000;
const handed = (): string[] => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    return [...heard];
};
const forgetHeard = (): void => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    heard = [];
};
beforeEach(() => {
    jest.useFakeTimers();
    heard = [];
    window.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `id`, update: null };
    Object.defineProperty(document, `readyState`, { configurable: true, get: () => `complete` });
    stubGlobal(`location`, {
        get href(): string {
            return heard.at(-1) ?? ``;
        },
        set href(link: string) {
            heard.push(link);
        },
    });
});

let app: App | undefined;
afterEach(() => {
    jest.advanceTimersByTime(LINK_GAP_WALK_MS);
    jest.useRealTimers();
    app?.unmount();
    app = undefined;
    unstubAllGlobals();
    delete window.__INTENTIC_DESKTOP__;
    resetSandboxScope();
    setExternalDirty(`b.docx`, false);
    setExternalDirty(`c.docx`, false);
});

// The guard as LocalFiles.vue holds it: set up with the component, listening once it is mounted.
const mountGuard = (): ReturnType<typeof useUnsavedGuard> => {
    let guard: ReturnType<typeof useUnsavedGuard> | undefined;
    app = createApp({
        setup: () => {
            guard = useUnsavedGuard();
            return () => null;
        },
    });
    app.mount(document.createElement(`div`));
    if (guard === undefined) {
        throw new Error(`the guard was not set up`);
    }
    return guard;
};
const editsTo = (path: string): void => {
    const { setBaseline, setBuffer } = useEditBuffers();
    setBaseline(path, `on disk`);
    setBuffer(path, `typed`);
};
const askToClose = (): void => {
    window.dispatchEvent(new CustomEvent(`intentic:close-requested`));
};

test("the app hears the window turn dirty and clean, whichever editor holds the edits, and once on mount", async () => {
    mountGuard();
    editsTo(`a.md`);
    await nextTick();
    // Still dirty, so nothing new to say.
    setExternalDirty(`b.docx`, true);
    await nextTick();
    useEditBuffers().forget(`a.md`);
    await nextTick();
    setExternalDirty(`b.docx`, false);
    await nextTick();
    expect(handed()).toEqual([CLEAN, DIRTY, CLEAN]);
});

test("a close is agreed to at once with nothing unsaved, and asked about, naming what would be lost, otherwise", async () => {
    const guard = mountGuard();
    askToClose();
    const clean = handed();
    editsTo(`a.md`);
    setExternalDirty(`b.docx`, true);
    await nextTick();
    forgetHeard();
    askToClose();
    const asked = [guard.asking.value, guard.question.value?.what, guard.question.value?.paths, handed()];
    // Keeping the window open tells the app nothing: the close it held back just never happens.
    guard.keepOpen();
    const kept = [guard.asking.value, handed()];
    askToClose();
    guard.closeAnyway();
    expect([clean, asked, kept, [guard.asking.value, handed()]]).toEqual([
        [CLEAN, CLOSE],
        [true, `window`, [`a.md`, `b.docx`], []],
        [false, []],
        [false, [CLOSE]],
    ]);
});

test("a browser tab, with no app to tell, sends nothing", async () => {
    delete window.__INTENTIC_DESKTOP__;
    mountGuard();
    editsTo(`a.md`);
    await nextTick();
    askToClose();
    expect(handed()).toEqual([]);
});

// A tab's × and Ctrl/Cmd+W both close through here: the window keeps no other copy of what was typed in a tab, so edits
// it holds go only on the reader's word, and a tab with none closes as silently as ever.
test("a tab holding unsaved edits closes only once the reader agrees, and one without closes at once", async () => {
    const guard = mountGuard();
    const { openFile, tabs } = useWorkspaceTabs();
    const { bufferOf } = useEditBuffers();
    const open = (): readonly string[] => tabs.value.map((tab) => tab.id);
    openFile(`a.md`, `keep`);
    openFile(`b.md`, `keep`);
    editsTo(`a.md`);
    await nextTick();
    forgetHeard();
    guard.closeTab(`a.md`);
    const held = [open(), guard.asking.value, guard.question.value?.what, guard.question.value?.paths, bufferOf(`a.md`)];
    guard.keepOpen();
    const kept = [open(), guard.asking.value, bufferOf(`a.md`)];
    guard.closeTab(`a.md`);
    guard.closeAnyway();
    await nextTick();
    const discarded = [open(), guard.asking.value, bufferOf(`a.md`), handed()];
    guard.closeTab(`b.md`);
    expect([held, kept, discarded, [open(), guard.asking.value]]).toEqual([
        [[`a.md`, `b.md`], true, `tab`, [`a.md`], `typed`],
        [[`a.md`, `b.md`], false, `typed`],
        // The edits go with the tab, and the window is clean again, so the app hears so.
        [[`b.md`], false, undefined, [CLEAN]],
        [[], false],
    ]);
});

test("a tab whose unsaved edits another editor holds asks too, and closing it clears them", () => {
    const guard = mountGuard();
    useWorkspaceTabs().openFile(`c.docx`, `keep`);
    setExternalDirty(`c.docx`, true);
    guard.closeTab(`c.docx`);
    const asked = [guard.asking.value, guard.question.value?.paths];
    guard.closeAnyway();
    expect([asked, [...externalDirtyPaths.value], useWorkspaceTabs().tabs.value]).toEqual([[true, [`c.docx`]], [], []]);
});
