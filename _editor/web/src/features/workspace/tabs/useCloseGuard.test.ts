import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type App, createApp } from "vue";
import { externalDirtyPaths, setExternalDirty } from "../files/externalDirty";
import { useEditBuffers } from "../files/useEditBuffers";
import { useCloseGuard } from "./useCloseGuard";
import { useWorkspaceTabs } from "./useWorkspaceTabs";

// Pins the workspace's one close guard, the hosted workspace's tab menu and a local window's tabs alike: a close that
// would discard unsaved work asks first, whichever editor holds that work, and a close the reader agrees to takes the
// work and its dirty flag with the tabs.

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    const { tabs, closeTabIds } = useWorkspaceTabs();
    closeTabIds(new Set(tabs.value.map((tab) => tab.id))).forEach((path) => useEditBuffers().forget(path));
    for (const path of [...externalDirtyPaths.value]) {
        setExternalDirty(path, false);
    }
    resetSandboxScope();
});

const mountGuard = (): ReturnType<typeof useCloseGuard> => {
    let guard: ReturnType<typeof useCloseGuard> | undefined;
    app = createApp({
        setup: () => {
            guard = useCloseGuard();
            return () => null;
        },
    });
    app.mount(document.createElement(`div`));
    if (guard === undefined) {
        throw new Error(`the guard was not set up`);
    }
    return guard;
};
const open = (): readonly string[] => useWorkspaceTabs().tabs.value.map((tab) => tab.id);
const openAll = (...paths: string[]): void => paths.forEach((path) => useWorkspaceTabs().openFile(path, `keep`));

// The hosted workspace's bulk close read only the editor's own buffers, so a Close All over an Office document with
// unsaved edits closed it without a word and left its dirty flag standing.
test("a bulk close of a tab whose only unsaved work an extension editor holds asks, and closing clears the flag", () => {
    const guard = mountGuard();
    openAll(`a.md`, `brief.docx`, `c.md`);
    setExternalDirty(`brief.docx`, true);
    guard.closeTabs(new Set([`a.md`, `brief.docx`]));
    const asked = [open(), guard.asking.value, guard.question.value?.what, guard.question.value?.paths];
    guard.closeAnyway();
    expect([asked, [open(), guard.asking.value, [...externalDirtyPaths.value]]]).toEqual([
        [[`a.md`, `brief.docx`, `c.md`], true, `tabs`, [`brief.docx`]],
        [[`c.md`], false, []],
    ]);
});

test("a bulk close with nothing unsaved among the closing tabs closes at once, whatever the others hold", () => {
    const guard = mountGuard();
    openAll(`a.md`, `b.md`, `c.md`);
    const { setBaseline, setBuffer, bufferOf } = useEditBuffers();
    setBaseline(`c.md`, `on disk`);
    setBuffer(`c.md`, `typed`);
    guard.closeTabs(new Set([`a.md`, `b.md`]));
    expect([open(), guard.asking.value, bufferOf(`c.md`)]).toEqual([[`c.md`], false, `typed`]);
});

test("a lone × close of a tab holding edits asks, and turning it down keeps the tab and the edits", () => {
    const guard = mountGuard();
    openAll(`a.md`);
    const { setBaseline, setBuffer, bufferOf } = useEditBuffers();
    setBaseline(`a.md`, `on disk`);
    setBuffer(`a.md`, `typed`);
    guard.closeTab(`a.md`);
    const asked = [guard.asking.value, guard.question.value?.what, guard.question.value?.paths];
    guard.keepOpen();
    const kept = [open(), guard.asking.value, bufferOf(`a.md`)];
    // An answer after the box is gone does nothing.
    guard.closeAnyway();
    expect([asked, kept, open()]).toEqual([[true, `tab`, [`a.md`]], [[`a.md`], false, `typed`], [`a.md`]]);
});

test("every unsaved file is listed once and in order, whichever editor holds it", () => {
    const guard = mountGuard();
    const { setBaseline, setBuffer } = useEditBuffers();
    setBaseline(`b.md`, `on disk`);
    setBuffer(`b.md`, `typed`);
    setExternalDirty(`a.docx`, true);
    setExternalDirty(`b.md`, true);
    expect([guard.dirty.value, guard.unsavedPaths()]).toEqual([true, [`a.docx`, `b.md`]]);
    useEditBuffers().forget(`b.md`);
});
