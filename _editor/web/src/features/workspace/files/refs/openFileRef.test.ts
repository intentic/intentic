// The full gesture: a rendered markdown link, a real click on it, and the editor tab that opens.
import "@intentic/testing/dom";
import { waitFor, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { effectScope } from "vue";
import type { WorkspaceResolve } from "@intentic/sandbox-contract";
import type { ProcedureInput } from "../../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";
import { treeCacheModule } from "../../../../testing/treeCache";

const openFile = jest.fn();
const openAtLine = jest.fn();
const push = jest.fn();
// Where the reader stands: the Workspace route opens a file in place, anywhere else it peeks beside.
const currentRoute = { value: { name: `agents` } };
const sectionReachable = jest.fn((_to: string) => true);
// Daemon's reference resolver; by default every reference names a real file as written, so a click opens it as is.
const asWritten = async (input: ProcedureInput<`workspace.resolve`>): Promise<WorkspaceResolve> => ({ path: input.path });
const resolve = jest.fn(asWritten);

jest.mock("../../../../lib/queryPersistence", treeCacheModule);
jest.mock("../../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ workspace: { resolve } }) }));
jest.mock("../../tabs/useWorkspaceTabs", () => ({ useWorkspaceTabs: () => ({ openFile, openAtLine }) }));
jest.mock("../../../../router", () => ({ router: { push, currentRoute } }));
jest.mock("../../../../workbench/views/registry", () => ({ sectionReachable }));

const { fileLinkDecorator, renderMarkdown } = await import("../../../../lib/markdown/renderMarkdown");
const { renderMarkdown: renderEngine } = await import("@intentic/ui/markdown");
const { openFileRefFromEvent, openInWorkspace } = await import("./openFileRef");
const { workspaceAgent } = await import("../../../../app/workspaceScope");
const { claimFloating } = await import("../../../../workbench/window/floating");
const { sideDocked, sideTabId, useSidePanel, closeAllTabs } = await import("../../../../workbench/side/sideTabs");
const { arrivalOf } = await import("../../../../workbench/side/sideFileInput");

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
    resolve.mockClear();
    resolve.mockImplementation(asWritten);
    workspaceAgent.value = undefined;
    sideDocked.value = false;
    currentRoute.value = { name: `agents` };
    sectionReachable.mockImplementation(() => true);
    closeAllTabs();
});

afterEach(() => {
    unstubAllGlobals();
});

describe(`clicking a file the agent mentioned`, () => {
    it(`opens it in the workspace at the named line, without a page navigation`, async () => {
        const event = clickFileLink(surface(`Fixed in src/foo.ts:42.`));
        await waitFor(() => expect(openAtLine).toHaveBeenCalledWith(`src/foo.ts`, 42));
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`src`, `foo.ts`] }, query: {} });
        expect(event.defaultPrevented).toBe(true);
    });

    it(`opens a line-less mention at the top of the file`, async () => {
        clickFileLink(surface("See `src/chat/useChat.ts` for the singleton."));
        await waitFor(() => expect(openFile).toHaveBeenCalledWith(`src/chat/useChat.ts`));
        expect(openAtLine).not.toHaveBeenCalled();
    });

    it(`opens the file an abbreviated mention resolves to, not the path as written`, async () => {
        resolve.mockResolvedValue({ path: `_editor/web/src/pages/Foo.vue` });
        clickFileLink(surface("Gone from `pages/Foo.vue`."));
        await waitFor(() => expect(openFile).toHaveBeenCalledWith(`_editor/web/src/pages/Foo.vue`));
        expect(resolve).toHaveBeenCalledWith({ path: `pages/Foo.vue`, agent: undefined });
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
        await waitFor(() => expect(openFile).toHaveBeenCalledWith(`docs/plan.md`));
        expect(workspaceAgent.value).toBe(`c-1`);
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`docs`, `plan.md`] }, query: { agent: `c-1` } });
    });

    // Scope is set before the daemon is asked, and travels with the question; the shared tree answers unmatched.
    it(`asks the daemon within that conversation's tree`, async () => {
        resolve.mockImplementation(async ({ agent }) => (agent === `c-1` ? { path: `docs/plan.md` } : {}));
        clickFileLink(scopedSurface("Wrote `plan.md/notes.md` just now."));
        await waitFor(() => expect(openFile).toHaveBeenCalledWith(`docs/plan.md`));
        expect(resolve).toHaveBeenCalledWith({ path: `plan.md/notes.md`, agent: `c-1` });
    });

    it(`takes the reader back out again when the next link is a shared one`, async () => {
        workspaceAgent.value = `c-1`;
        clickFileLink(surface(`Also in src/foo.ts.`));
        await waitFor(() => expect(openFile).toHaveBeenCalledWith(`src/foo.ts`));
        expect(workspaceAgent.value).toBeUndefined();
    });
});

// A popped-out panel has no app window to open a file in, so the click goes to the app's own window instead.
describe(`clicking a file in a popped-out panel`, () => {
    it(`sends it to the app's own window rather than routing this one`, () => {
        const open = jest.fn(() => null);
        stubGlobal(`open`, open);
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, jest.fn()));

        clickFileLink(surface(`Fixed in src/foo.ts:42.`));

        expect(openAtLine).not.toHaveBeenCalled();
        expect(openFile).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledWith(`/workspace`, `intentic-main`);
        scope.stop();
    });

    // A popped-out chat draws a side panel of its own (FloatingSection.vue), so the file is looked at where it was named.
    it(`peeks it in a popped-out chat's own side panel`, async () => {
        const open = jest.fn(() => null);
        stubGlobal(`open`, open);
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, jest.fn()));
        sideDocked.value = true;
        currentRoute.value = { name: `floating` };

        clickFileLink(surface(`Fixed in src/foo.ts:42.`));

        await waitFor(() => expect(useSidePanel().tabs.value.map((tab) => tab.input)).toEqual([{ path: `src/foo.ts` }]));
        expect(open).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        scope.stop();
    });

    it(`sends "Open in Workspace" from there to the app's own window, never routing this one`, async () => {
        const open = jest.fn(() => null);
        stubGlobal(`open`, open);
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, jest.fn()));

        await openInWorkspace(`src/foo.ts`, undefined, { agent: undefined });

        expect(push).not.toHaveBeenCalled();
        expect(openFile).not.toHaveBeenCalled();
        expect(open).toHaveBeenCalledWith(`/workspace`, `intentic-main`);
        scope.stop();
    });
});

// With a side panel in the window, a file named anywhere but the Workspace is looked at beside the section the reader
// picked, which stays in the main area.
describe(`clicking a file with the side panel in the window`, () => {
    const panel = useSidePanel();
    const scopedSurface = (markdown: string): HTMLDivElement => {
        const root = document.createElement(`div`);
        root.addEventListener(`click`, openFileRefFromEvent);
        root.innerHTML = renderEngine(markdown, fileLinkDecorator({ agent: `c-1` }));
        return root;
    };

    beforeEach(() => {
        sideDocked.value = true;
    });

    it(`peeks it beside the section, at the named line, and leaves the main area where it was`, async () => {
        const event = clickFileLink(surface(`Fixed in src/foo.ts:42.`));
        await waitFor(() => expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ path: `src/foo.ts` }]));
        const id = sideTabId(`file`, { path: `src/foo.ts` });
        expect(panel.peek.value).toBe(id);
        expect(panel.jumps.value[id]?.line).toBe(42);
        expect(push).not.toHaveBeenCalled();
        expect(openAtLine).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    it(`reads an isolated conversation's own copy without switching the Workspace to it`, async () => {
        resolve.mockImplementation(async ({ agent }) => (agent === `c-1` ? { path: `docs/plan.md` } : {}));
        clickFileLink(scopedSurface("Wrote `plan.md/notes.md` just now."));
        await waitFor(() => expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ path: `docs/plan.md`, agent: `c-1` }]));
        expect(resolve).toHaveBeenCalledWith({ path: `plan.md/notes.md`, agent: `c-1` });
        expect(workspaceAgent.value).toBeUndefined();
    });

    it(`replaces the last peek with the next link followed`, async () => {
        clickFileLink(surface(`See src/a.ts.`));
        await waitFor(() => expect(panel.tabs.value).toHaveLength(1));
        clickFileLink(surface(`And src/b.ts.`));
        await waitFor(() => expect(panel.tabs.value.map((tab) => tab.input)).toEqual([{ path: `src/b.ts` }]));
    });

    it(`opens it in the Workspace itself while the reader stands there`, async () => {
        currentRoute.value = { name: `workspace` };
        clickFileLink(surface(`Fixed in src/foo.ts:42.`));
        await waitFor(() => expect(openAtLine).toHaveBeenCalledWith(`src/foo.ts`, 42));
        expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`src`, `foo.ts`] }, query: {} });
        expect(panel.tabs.value).toEqual([]);
    });

    it(`keeps the Workspace route for a reader the Workspace is closed to`, async () => {
        sectionReachable.mockImplementation((to) => to !== `/workspace`);
        clickFileLink(surface(`Fixed in src/foo.ts:42.`));
        await waitFor(() => expect(push).toHaveBeenCalledWith({ name: `workspace`, params: { path: [`src`, `foo.ts`] }, query: {} }));
        expect(panel.tabs.value).toEqual([]);
    });
});

// What the daemon answers is said where the reader looks: nothing matched is a card of its own, several matches are a
// way through them, and a renamed file says so, rather than a guessed path opening and reading as deleted.
describe(`a reference that is not simply one file`, () => {
    const panel = useSidePanel();
    const inputs = () => panel.tabs.value.map((tab) => tab.input);

    beforeEach(() => {
        sideDocked.value = true;
    });

    it(`opens a card saying nothing matched, with what it may have meant, instead of a file that never existed`, async () => {
        resolve.mockResolvedValue({ nearby: [`intentic/_os/installer/bib-config.toml`] });
        clickFileLink(surface("The installer config `installer/config.toml` is ready."));
        await waitFor(() => expect(inputs()).toEqual([{ path: `installer/config.toml`, missing: true }]));
        expect(arrivalOf({ path: `installer/config.toml`, missing: true })).toEqual({
            asked: `installer/config.toml`,
            nearby: [`intentic/_os/installer/bib-config.toml`],
        });
    });

    it(`opens the likeliest of several matches and keeps the rest to step through`, async () => {
        resolve.mockResolvedValue({ path: `a/pages/index.md`, others: [`b/c/pages/index.md`] });
        clickFileLink(surface("See `pages/index.md`."));
        await waitFor(() => expect(inputs()).toEqual([{ path: `a/pages/index.md` }]));
        expect(arrivalOf({ path: `a/pages/index.md` })?.matches).toEqual([`a/pages/index.md`, `b/c/pages/index.md`]);
    });

    it(`opens a renamed file where it went and remembers the name it was asked by`, async () => {
        resolve.mockResolvedValue({ path: `_os/installer/bib-config.toml`, renamedFrom: `_os/installer/config.toml` });
        clickFileLink(surface("See `installer/config.toml`."));
        await waitFor(() => expect(inputs()).toEqual([{ path: `_os/installer/bib-config.toml` }]));
        expect(arrivalOf({ path: `_os/installer/bib-config.toml` })?.renamedFrom).toBe(`_os/installer/config.toml`);
    });

    it(`says nothing extra about a reference that named exactly one file`, async () => {
        clickFileLink(surface(`Fixed in src/foo.ts.`));
        await waitFor(() => expect(inputs()).toEqual([{ path: `src/foo.ts` }]));
        expect(arrivalOf({ path: `src/foo.ts` })).toBeUndefined();
    });

    it(`opens the reference as written when the daemon cannot be asked, and lets the file say what it finds`, async () => {
        resolve.mockRejectedValue(new Error(`offline`));
        clickFileLink(surface(`Fixed in src/foo.ts.`));
        await waitFor(() => expect(inputs()).toEqual([{ path: `src/foo.ts` }]));
    });

    it(`standing in the Workspace, opens no editor tab for a reference that matched nothing, and leaves its copy alone`, async () => {
        currentRoute.value = { name: `workspace` };
        resolve.mockResolvedValue({});
        clickFileLink(surface(`Fixed in src/nowhere.ts.`));
        await waitFor(() => expect(inputs()).toEqual([{ path: `src/nowhere.ts`, missing: true }]));
        expect(openFile).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        expect(workspaceAgent.value).toBeUndefined();
    });
});
