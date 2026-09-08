// @vitest-environment jsdom
// The full gesture: a rendered markdown link, a real click on it, and the editor tab that opens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

const openFile = vi.fn();
const openAtLine = vi.fn();
const push = vi.fn();
// Daemon's reference resolver; unmatched by default so a click opens the path as written.
const resolved = vi.fn<() => { path?: string }>(() => ({}));

vi.mock("../../../lib/queryPersistence", () => ({ queryClient: { getQueriesData: () => [] } }));
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJson: () => Promise.resolve(resolved()) }));
vi.mock("../tabs/useWorkspaceTabs", () => ({ useWorkspaceTabs: () => ({ openFile, openAtLine }) }));
vi.mock("../../../router", () => ({ router: { push } }));

const { fileLinkDecorator, renderMarkdown } = await import("../../../lib/markdown/renderMarkdown");
const { renderMarkdown: renderEngine } = await import("@intentic/ui/markdown");
const { openFileRefFromEvent } = await import("./openFileRef");
const { workspaceAgent } = await import("../health/workspaceScope");
const { claimFloating } = await import("../../../shell/window/floating");

// Binds a click listener the way ChatMessageView and MarkdownViewer do, then renders markdown into it.
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
    workspaceAgent.value = undefined;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`clicking a file the agent mentioned`, () => {
    it(`opens it in the workspace at the named line, without a page navigation`, async () => {
        const event = clickFileLink(surface(`Fixed in src/foo.ts:42.`));
        await vi.waitFor(() => expect(openAtLine).toHaveBeenCalledWith(`src/foo.ts`, 42));
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`src`, `foo.ts`] }, query: {} });
        expect(event.defaultPrevented).toBe(true);
    });

    it(`opens a line-less mention at the top of the file`, async () => {
        clickFileLink(surface("See `src/chat/useChat.ts` for the singleton."));
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`src/chat/useChat.ts`));
        expect(openAtLine).not.toHaveBeenCalled();
    });

    it(`opens the file an abbreviated mention resolves to, not the path as written`, async () => {
        resolved.mockReturnValue({ path: `_editor/web/src/pages/Foo.vue` });
        clickFileLink(surface("Gone from `pages/Foo.vue`."));
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`_editor/web/src/pages/Foo.vue`));
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`_editor`, `web`, `src`, `pages`, `Foo.vue`] }, query: {} });
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

// A link inside an isolated conversation opens that conversation's own copy of the file, not the shared one.
describe(`clicking a file an isolated conversation mentioned`, () => {
    const scopedSurface = (markdown: string): HTMLDivElement => {
        const root = document.createElement(`div`);
        root.addEventListener(`click`, openFileRefFromEvent);
        root.innerHTML = renderEngine(markdown, fileLinkDecorator({ agent: `c-1` }));
        return root;
    };

    it(`carries the conversation into the scope and into the route`, async () => {
        clickFileLink(scopedSurface(`Wrote docs/plan.md just now.`));
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`docs/plan.md`));
        expect(workspaceAgent.value).toBe(`c-1`);
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`docs`, `plan.md`] }, query: { agent: `c-1` } });
    });

    // Scope is set before the daemon is asked; resolving against the shared tree returns unmatched.
    it(`asks the daemon within that conversation's tree`, async () => {
        resolved.mockImplementation(() => ({ path: workspaceAgent.value === `c-1` ? `docs/plan.md` : undefined }));
        clickFileLink(scopedSurface("Wrote `plan.md/notes.md` just now."));
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`docs/plan.md`));
    });

    it(`takes the reader back out again when the next link is a shared one`, async () => {
        workspaceAgent.value = `c-1`;
        clickFileLink(surface(`Also in src/foo.ts.`));
        await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(`src/foo.ts`));
        expect(workspaceAgent.value).toBeUndefined();
    });
});

// A popped-out panel has no app window to open a file in, so the click goes to the app's own window instead.
describe(`clicking a file in a popped-out panel`, () => {
    it(`sends it to the app's own window rather than routing this one`, () => {
        const open = vi.fn(() => null);
        vi.stubGlobal(`open`, open);
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, vi.fn()));

        clickFileLink(surface(`Fixed in src/foo.ts:42.`));

        expect(openAtLine).not.toHaveBeenCalled();
        expect(openFile).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledWith(`/workspace`, `intentic-main`);
        scope.stop();
    });
});
