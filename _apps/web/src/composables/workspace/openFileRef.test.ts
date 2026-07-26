// @vitest-environment jsdom
//
// The gesture end to end: markdown the agent wrote → rendered anchors → a real click on one → the editor tab
// that opens. Every piece in between (the link markup, the delegated listener, the modifier gating) only means
// anything joined up, and this is the only test that joins them.
import { beforeEach, describe, expect, it, vi } from "vitest";

const openFile = vi.fn();
const openAtLine = vi.fn();
const push = vi.fn();

vi.mock("../queryPersistence", () => ({ queryClient: { getQueriesData: () => [] } }));
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
});

describe(`clicking a file the agent mentioned`, () => {
    it(`opens it in the workspace at the named line, without a page navigation`, () => {
        const event = clickFileLink(surface(`Fixed in src/foo.ts:42.`));
        expect(openAtLine).toHaveBeenCalledWith(`src/foo.ts`, 42);
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`src`, `foo.ts`] } });
        // Not prevented, the browser would follow the href and reload the whole SPA.
        expect(event.defaultPrevented).toBe(true);
    });

    it(`opens a line-less mention at the top of the file`, () => {
        clickFileLink(surface("See `src/chat/useChat.ts` for the singleton."));
        expect(openFile).toHaveBeenCalledWith(`src/chat/useChat.ts`);
        expect(openAtLine).not.toHaveBeenCalled();
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
