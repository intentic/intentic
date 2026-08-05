// @vitest-environment jsdom
//
// The gesture end to end: markdown the agent wrote → rendered anchors → a real click on one → the editor tab
// that opens. Every piece in between (the link markup, the delegated listener, the modifier gating) only means
// anything joined up, and this is the only test that joins them.
import { beforeEach, describe, expect, it, vi } from "vitest";

const openFile = vi.fn();
const openAtLine = vi.fn();
const push = vi.fn();
// The daemon's reference resolver. Nothing is cached client-side here (the tree query is stubbed empty), so
// every click asks it; by default it matches nothing and the reference opens as written.
const resolved = vi.fn<() => { path?: string }>(() => ({}));

vi.mock("../queryPersistence", () => ({ queryClient: { getQueriesData: () => [] } }));
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: () => Promise.resolve(resolved()) }));
vi.mock("./useWorkspaceTabs", () => ({ useWorkspaceTabs: () => ({ openFile, openAtLine }) }));
vi.mock("../../router", () => ({ router: { push } }));

const { renderMarkdown } = await import("../renderMarkdown");
const { openFileRefFromEvent } = await import("./openFileRef");

// A prose surface bound exactly as ChatMessageView and MarkdownViewer bind it: one delegated listener on the
// root, the rendered markdown injected beneath it.
const surface = (markdown: string): HTMLDivElement => {
    const root = document.createElement(`div`);
    root.addEventListener(`click`, openFileRefFromEvent);
    root.innerHTML = renderMarkdown(markdown);
    return root;
};

const clickFileLink = (root: HTMLElement, init: MouseEventInit = {}): MouseEvent => {
    const link = root.querySelector(`a.md-file-link`);
    expect(link).not.toBeNull();
    const event = new MouseEvent(`click`, { bubbles: true, cancelable: true, ...init });
    link?.dispatchEvent(event);
    return event;
};

beforeEach(() => {
    openFile.mockClear();
    openAtLine.mockClear();
    push.mockClear();
    resolved.mockReturnValue({});
});

describe(`clicking a file the agent mentioned`, () => {
    it(`opens it in the workspace at the named line, without a page navigation`, async () => {
        const event = clickFileLink(surface(`Fixed in src/foo.ts:42.`));
        await vi.waitFor(() => expect(openAtLine).toHaveBeenCalledWith(`src/foo.ts`, 42));
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`src`, `foo.ts`] } });
        // Not prevented, the browser would follow the href and reload the whole SPA.
        expect(event.defaultPrevented).toBe(true);
    });

    it(`opens a line-less mention at the top of the file`, async () => {
        clickFileLink(surface("See `src/chat/useChat.ts` for the singleton."));
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`src/chat/useChat.ts`));
        expect(openAtLine).not.toHaveBeenCalled();
    });

    // The whole point of resolving on click: the model writes the tail of a path once the area is established.
    it(`opens the file an abbreviated mention resolves to, not the path as written`, async () => {
        resolved.mockReturnValue({ path: `_editor/web/src/pages/Foo.vue` });
        clickFileLink(surface("Gone from `pages/Foo.vue`."));
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`_editor/web/src/pages/Foo.vue`));
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`_editor`, `web`, `src`, `pages`, `Foo.vue`] } });
    });

    it(`leaves a modified click to the browser, so ⌘/ctrl-click still opens a real new tab`, () => {
        const event = clickFileLink(surface(`Fixed in src/foo.ts:42.`), { metaKey: true });
        expect(event.defaultPrevented).toBe(false);
        expect(openAtLine).not.toHaveBeenCalled();
    });

    it(`ignores clicks on the surrounding prose`, () => {
        const root = surface(`Fixed in src/foo.ts:42.`);
        root.dispatchEvent(new MouseEvent(`click`, { bubbles: true, cancelable: true }));
        expect(openFile).not.toHaveBeenCalled();
        expect(openAtLine).not.toHaveBeenCalled();
    });
});
