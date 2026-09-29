// The open-file dispatcher mounted for real: which surface a tab ends on, and what it hands that surface. jsdom, since
// what is asserted is what is on screen.
import "@intentic/testing/dom";
import type { WorkspaceFileResponse } from "@intentic/api-contract";
import { type App, computed, createApp, defineComponent, h, nextTick, provide, ref, useSlots } from "vue";
import { IconStub } from "@intentic/ui/testing";

// The daemon's two reads, stood in for at the viewer's seams: a file's text window, and its bytes. Each text read says
// whose copy it asked for, since a surface may read another than the Workspace's.
let answer: (path: string) => WorkspaceFileResponse = (path) => ({ present: false, path });
const reads: { path: string; agent: string | undefined }[] = [];
jest.mock("../files/fileWindow", () => ({
    FILE_WINDOW_BYTES: 4 * 1024 * 1024,
    readFileWindow: (path: string, opts?: { scope?: { agent: string | undefined } }) => {
        reads.push({ path, agent: opts?.scope?.agent });
        return Promise.resolve(answer(path));
    },
}));
jest.mock("../../sandbox/client/sandboxClient", () => ({
    sandboxBlob: (path: string) => Promise.resolve(new Blob([`bytes of ${path}`])),
}));
// The tree's write half and tier: the owner's, with nothing written here.
jest.mock("../explorer/useWorkspaceTree", () => ({
    useWorkspaceTree: () => ({
        saveText: () => Promise.resolve(),
        run: (work: () => Promise<void>) => work(),
        canEditFiles: ref(true),
        entry: () => undefined,
    }),
}));
jest.mock("../health/scopeTitle", () => ({ useScopeTitle: () => computed(() => ``) }));
// Monaco and its grammars are the editor's own business: warmed here, never loaded.
jest.mock("../files/useMonaco", () => ({
    useMonaco: () => ({ ensureMonaco: () => new Promise(() => undefined), ensureLanguage: () => undefined }),
}));

// The text surfaces stand in as what they were handed, which is what this file decides.
const surface = (name: string) =>
    defineComponent({
        props: { editable: Boolean, path: String, code: String, source: String },
        setup: (props) => () => h(`section`, { class: name, "data-editable": String(props.editable), "data-path": props.path }, props.code ?? props.source),
    });
jest.mock("./CodeView.vue", () => ({ default: surface(`code-view`) }));
jest.mock("./MarkdownViewer.vue", () => ({ default: surface(`markdown-view`) }));
jest.mock("./DerivedTextView.vue", () => ({
    default: defineComponent({ props: { path: String }, setup: (props) => () => h(`aside`, { class: `derived-text` }, `text of ${props.path}`) }),
}));

const { default: FileViewer } = await import("./FileViewer.vue");
const { registerViewer } = await import("../../../core-views/viewerRegistry");
const { externalDirtyPaths } = await import("../files/externalDirty");
const { VIEW_SCOPE, workspaceAgent } = await import("../health/workspaceScope");
const { useEditBuffers } = await import("../files/useEditBuffers");

// Where a `path` viewer said its document's unsaved edits go, kept past the viewer the way ONLYOFFICE's kept editor
// keeps it; and how many times a viewer was set up, which is how often the tab drew it anew.
let reportUnsaved: ((dirty: boolean) => void) | undefined;
let setups = 0;

// An extension's viewer: says what it was handed, shows the host's text reading when there is one, and can say its
// editor holds unsaved work.
const FakeViewer = defineComponent({
    props: { path: String, blob: Blob, agent: String, readOnly: Boolean, unsaved: Function },
    emits: [`download`],
    setup: (props) => {
        setups += 1;
        const slots = useSlots();
        // SAFETY: FileViewer hands a `path` viewer `unsaved` as a report function (pathViewerProps), or nothing.
        reportUnsaved = props.unsaved as ((dirty: boolean) => void) | undefined;
        return () =>
            h(`article`, { class: `fake-viewer`, "data-read-only": String(props.readOnly), "data-blob": String(props.blob !== undefined) }, [
                `viewer of ${props.path}`,
                slots[`text`]?.(),
            ]);
    },
});

const disposables: { dispose: () => void }[] = [];
const register = (extensions: readonly string[], fetch: `blob` | `path`): void => {
    disposables.push(
        registerViewer({ owner: `intentic.viewers`, id: `fake-${fetch}`, extensions, fetch, edit: fetch === `path`, component: async () => FakeViewer }),
    );
};

let app: App | undefined;
// `readOnly` draws it as a look; `scope` is the copy a surface around it names (the side panel's), none for the Workspace's.
const mount = (path: string, options: { readOnly?: true; scope?: string } = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        setup: () => {
            if (options.scope !== undefined) {
                provide(VIEW_SCOPE, ref(options.scope));
            }
            return () => h(FileViewer, { path, readOnly: options.readOnly });
        },
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// Reads and chunk loads resolve on the microtask queue; a macrotask turn and a render later, the surface is drawn.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    await nextTick();
};

const text = (path: string, content: string, extra: { lossy?: true } = {}): WorkspaceFileResponse => ({
    present: true,
    path,
    content,
    size: content.length,
    offset: 0,
    bytes: content.length,
    shared: true,
    ...extra,
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    while (disposables.length > 0) {
        disposables.pop()?.dispose();
    }
    window.__INTENTIC_LOCAL__ = undefined;
    workspaceAgent.value = undefined;
    reportUnsaved?.(false);
    reportUnsaved = undefined;
    setups = 0;
    reads.length = 0;
    answer = (path) => ({ present: false, path });
    document.body.innerHTML = ``;
});

describe(`a viewer that registers after the tab opened`, () => {
    it(`takes the tab over from the file's text, and hands it back when it goes`, async () => {
        const element = mount(`report.pdf`);
        await settle();
        // Nothing claims the format yet: its text is all there is to show.
        expect(element.querySelector(`.derived-text`)?.textContent).toBe(`text of report.pdf`);
        expect(element.querySelector(`.fake-viewer`)).toBeNull();

        register([`pdf`], `blob`);
        await settle();
        expect(element.querySelector(`.fake-viewer`)?.textContent).toContain(`viewer of report.pdf`);
        expect(element.querySelector(`.fake-viewer`)?.getAttribute(`data-blob`)).toBe(`true`);
        expect(element.querySelector(`.derived-text`)).toBeNull();

        disposables.pop()?.dispose();
        await settle();
        expect(element.querySelector(`.fake-viewer`)).toBeNull();
        expect(element.querySelector(`.derived-text`)?.textContent).toBe(`text of report.pdf`);
    });

    it(`replaces "Preview isn't available" where the file has no text to fall back on`, async () => {
        // A conversation's own copy is never shadowed, so there an unclaimed format is simply unsupported.
        workspaceAgent.value = `c-1`;
        const element = mount(`report.pdf`);
        await settle();
        expect(element.textContent).toContain(`Preview isn't available for this file type.`);

        register([`pdf`], `blob`);
        await settle();
        expect(element.querySelector(`.fake-viewer`)?.textContent).toContain(`viewer of report.pdf`);
        expect(element.textContent).not.toContain(`Preview isn't available`);
    });
});

// A read the file server could only decode with replacement characters: what is on screen is not the file's bytes, so
// a save would change the file. Shown, said so, and never offered for editing.
describe(`a file that isn't UTF-8`, () => {
    it(`opens read-only under a line saying why, with no Save`, async () => {
        answer = (path) => text(path, `caf� au lait`, { lossy: true });
        const element = mount(`menu.txt`);
        await settle();
        expect(element.querySelector(`.code-view`)?.getAttribute(`data-editable`)).toBe(`false`);
        expect(element.textContent).toContain(`This file isn't UTF-8 text, so it opens read-only here.`);
        expect(element.querySelector(`[aria-label="Save file"]`)).toBeNull();
    });

    it(`is edited as ever when it decoded cleanly`, async () => {
        answer = (path) => text(path, `café au lait`);
        const element = mount(`menu.txt`);
        await settle();
        expect(element.querySelector(`.code-view`)?.getAttribute(`data-editable`)).toBe(`true`);
        expect(element.textContent).not.toContain(`isn't UTF-8`);
        expect(element.querySelector(`[aria-label="Save file"]`)).not.toBeNull();
    });
});

// The side panel's peek: a look at a file beside the reader's section, which never edits, since the Workspace may hold
// the same path open with unsaved work in the one buffer a path has.
describe(`a look`, () => {
    it(`shows the file with no caret and no Save, and says where editing happens`, async () => {
        answer = (path) => text(path, `export const a = 1;`);
        const element = mount(`src/a.ts`, { readOnly: true });
        await settle();
        expect(element.querySelector(`.code-view`)?.getAttribute(`data-editable`)).toBe(`false`);
        expect(element.querySelector(`.code-view`)?.textContent).toBe(`export const a = 1;`);
        expect(element.querySelector(`[aria-label="Save file"]`)).toBeNull();
        expect(element.textContent).toContain(`Read-only`);
    });

    it(`writes no baseline and shows disk, even with unsaved work on the path elsewhere`, async () => {
        const edit = useEditBuffers();
        edit.setBaseline(`src/b.ts`, `old`);
        edit.setBuffer(`src/b.ts`, `mine, unsaved`);
        answer = (path) => text(path, `new on disk`);
        const element = mount(`src/b.ts`, { readOnly: true });
        await settle();
        expect(element.querySelector(`.code-view`)?.textContent).toBe(`new on disk`);
        expect(edit.baselineOf(`src/b.ts`)).toBe(`old`);
        expect(edit.bufferOf(`src/b.ts`)).toBe(`mine, unsaved`);
        edit.forget(`src/b.ts`);
    });

    it(`tells a viewer that edits through its own backend that it may not write`, async () => {
        register([`docx`], `path`);
        const element = mount(`brief.docx`, { readOnly: true });
        await settle();
        expect(element.querySelector(`.fake-viewer`)?.getAttribute(`data-read-only`)).toBe(`true`);
    });
});

// A surface naming a copy of its own reads that copy, and leaves the Workspace's scope where it was.
describe(`a copy named by the surface around the viewer`, () => {
    it(`reads the conversation's checkout it names, read-only, without switching the Workspace`, async () => {
        answer = (path) => text(path, `plan`);
        const element = mount(`docs/plan.md`, { scope: `c-9` });
        await settle();
        expect(reads).toEqual([{ path: `docs/plan.md`, agent: `c-9` }]);
        expect(element.querySelector(`.markdown-view`)?.getAttribute(`data-editable`)).toBe(`false`);
        expect(workspaceAgent.value).toBeUndefined();
    });

    it(`reads the Workspace's own scope when nothing names one`, async () => {
        workspaceAgent.value = `c-2`;
        answer = (path) => text(path, `plan`);
        mount(`docs/plan.md`);
        await settle();
        expect(reads).toEqual([{ path: `docs/plan.md`, agent: `c-2` }]);
    });
});

// The desktop app opened one document on its own: that document is the window's to change, and nothing else in its
// folder, whose file server refuses those writes anyway.
describe(`a document window`, () => {
    const documentWindow = (file: string): void => {
        window.__INTENTIC_LOCAL__ = { daemonUrl: `http://127.0.0.1:4100`, token: `t`, id: `f`, name: file, path: `/home/me/notes`, file };
    };

    it(`edits its own document`, async () => {
        documentWindow(`drafts/letter.txt`);
        answer = (path) => text(path, `Dear Ann,`);
        const element = mount(`drafts/letter.txt`);
        await settle();
        expect(element.querySelector(`.code-view`)?.getAttribute(`data-editable`)).toBe(`true`);
    });

    it(`opens any other file of the folder read-only`, async () => {
        documentWindow(`drafts/letter.txt`);
        answer = (path) => text(path, `milk, eggs`);
        const element = mount(`drafts/list.txt`);
        await settle();
        expect(element.querySelector(`.code-view`)?.getAttribute(`data-editable`)).toBe(`false`);
        expect(element.querySelector(`[aria-label="Save file"]`)).toBeNull();
        expect(element.textContent).toContain(`Read-only`);
    });

    it(`tells a viewer that edits through its own backend that the file is not the window's to write`, async () => {
        documentWindow(`drafts/letter.docx`);
        register([`docx`], `path`);
        const other = mount(`drafts/budget.docx`);
        await settle();
        expect(other.querySelector(`.fake-viewer`)?.getAttribute(`data-read-only`)).toBe(`true`);
        app?.unmount();
        const own = mount(`drafts/letter.docx`);
        await settle();
        expect(own.querySelector(`.fake-viewer`)?.getAttribute(`data-read-only`)).toBe(`false`);
    });
});

// ONLYOFFICE keeps its own document, so its unsaved edits are only what it says: counted with the edit buffers for the
// window's close guard, and let go when the viewer goes, since it is told to save on leaving.
describe(`a viewer's own unsaved work`, () => {
    it(`counts for the file while its editor says so`, async () => {
        register([`docx`], `path`);
        mount(`brief.docx`);
        await settle();
        reportUnsaved?.(true);
        expect([...externalDirtyPaths.value]).toEqual([`brief.docx`]);
        reportUnsaved?.(false);
        expect([...externalDirtyPaths.value]).toEqual([]);
    });

    // The editor outlives the tab (kept to come back to, still saving), so the tab going says nothing about its edits.
    it(`still counts once the tab has gone, until the editor says it saved`, async () => {
        register([`docx`], `path`);
        mount(`brief.docx`);
        await settle();
        reportUnsaved?.(true);
        app?.unmount();
        app = undefined;
        expect([...externalDirtyPaths.value]).toEqual([`brief.docx`]);
        reportUnsaved?.(false);
        expect([...externalDirtyPaths.value]).toEqual([]);
    });

    it(`still counts when the reader turns to the file's text instead`, async () => {
        register([`docx`], `path`);
        const element = mount(`brief.docx`);
        await settle();
        reportUnsaved?.(true);
        [...element.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Text`))?.click();
        await settle();
        expect(element.querySelector(`.fake-viewer`)).toBeNull();
        expect([...externalDirtyPaths.value]).toEqual([`brief.docx`]);
    });
});

// An extension activated again (a language change) registers the same viewer anew: the tab it draws is not reloaded,
// which would throw away an editor, a scroll position, a zoom.
it(`keeps a viewer that registers again as itself`, async () => {
    register([`pdf`], `blob`);
    const element = mount(`report.pdf`);
    await settle();
    expect(setups).toBe(1);
    // Deactivated and activated again in one go, as the host does.
    disposables.pop()?.dispose();
    register([`pdf`], `blob`);
    await settle();
    expect(element.querySelector(`.fake-viewer`)?.textContent).toContain(`viewer of report.pdf`);
    expect(setups).toBe(1);
});

// A local window's file server derives text too, so a viewer that can't draw its file yet may show that meanwhile.
describe(`the text slot`, () => {
    it(`hands a viewer the file's text reading in a local window`, async () => {
        window.__INTENTIC_LOCAL__ = { daemonUrl: `http://127.0.0.1:4100`, token: `t`, id: `f`, name: `notes`, path: `/home/me/notes` };
        register([`docx`], `path`);
        const element = mount(`brief.docx`);
        await settle();
        expect(element.querySelector(`.fake-viewer .derived-text`)?.textContent).toBe(`text of brief.docx`);
    });

    it(`hands nothing in the workspace, where the viewer's own card stands`, async () => {
        register([`docx`], `path`);
        const element = mount(`brief.docx`);
        await settle();
        expect(element.querySelector(`.fake-viewer`)?.textContent).toBe(`viewer of brief.docx`);
        expect(element.querySelector(`.derived-text`)).toBeNull();
    });
});

// Floating over the content rather than the whole viewer: a banner above the content (a file changed on disk) keeps its
// Reload uncovered.
it(`floats Copy over the content, not over the lines above it`, async () => {
    answer = (path) => text(path, `café au lait`, { lossy: true });
    const element = mount(`menu.txt`);
    await settle();
    const copy = element.querySelector(`[aria-label="Copy file content"]`);
    expect(copy?.closest(`.min-h-0.flex-1`)?.querySelector(`.code-view`)).not.toBeNull();
    expect(copy?.closest(`.min-h-0.flex-1`)?.textContent).not.toContain(`isn't UTF-8`);
});
