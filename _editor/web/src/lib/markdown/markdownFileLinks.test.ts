import { WORKSPACE_ROOT } from "@intentic/constants";
// @vitest-environment jsdom
// Needs jsdom: the linkifier and DOMPurify require a real document. Asserted end-to-end through renderMarkdown since
// the order (parse, sanitize, then linkify) is what's pinned.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The container-root lookup reads the workspace-tree query; `queryData` is that seam.
let queryData: { root?: string; tree?: unknown[] }[] = [];
vi.mock("../queryPersistence", () => ({
    queryClient: { getQueriesData: () => queryData.map((data) => [[], data] as const) },
}));

const { fileLinkDecorator, renderMarkdown } = await import("./renderMarkdown");
const { renderMarkdown: renderEngine } = await import("@intentic/ui/markdown");

// A previewed file renders through the kit's <Markdown> with the app's decorator, the only surface that knows a
// directory to resolve against.
const renderIn = (dir: string, source: string): string => renderEngine(source, fileLinkDecorator({ dir }));

beforeEach(() => {
    queryData = [];
});

// The rendered anchor for `path`, or undefined; parsed from the HTML so assertions read as DOM shape, not string
// matching.
const linkTo = (html: string, path: string): HTMLAnchorElement | undefined => {
    const holder = document.createElement(`div`);
    holder.innerHTML = html;
    return holder.querySelector<HTMLAnchorElement>(`a[data-file="${path}"]`) ?? undefined;
};

describe(`file mentions in agent prose`, () => {
    it(`linkifies a bare path, carrying the workspace route and the line`, () => {
        const link = linkTo(renderMarkdown(`Fixed it in src/foo.ts:42 today.`), `src/foo.ts`);
        expect(link?.textContent).toBe(`foo.ts:42`);
        expect(link?.getAttribute(`title`)).toBe(`src/foo.ts:42`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/src/foo.ts`);
        expect(link?.dataset[`line`]).toBe(`42`);
        expect(link?.classList.contains(`md-file-link`)).toBe(true);
    });

    it(`linkifies a path in backticks: the form agents reach for most`, () => {
        const html = renderMarkdown("See the `src/chat/useChat.ts` singleton.");
        const link = linkTo(html, `src/chat/useChat.ts`);
        expect(link?.closest(`code`)).not.toBeNull();
    });

    it(`reads the line off whichever notation the reference arrived in`, () => {
        const forms = [`src/foo.ts:42`, `src/foo.ts(42,7)`, `[the config](src/foo.ts#L42)`, `[the config](src/foo.ts#L42-L58)`];
        for (const form of forms) {
            expect(linkTo(renderMarkdown(form), `src/foo.ts`)?.dataset[`line`]).toBe(`42`);
        }
    });

    it(`shows a deep path by its filename: the sentence stays readable, the link still lands`, () => {
        const link = linkTo(
            renderMarkdown(`gone from _editor/web/src/pages/workspace/WorkspaceDesktop.vue:640`),
            `_editor/web/src/pages/workspace/WorkspaceDesktop.vue`,
        );
        expect(link?.textContent).toBe(`WorkspaceDesktop.vue:640`);
        expect(link?.getAttribute(`title`)).toBe(`_editor/web/src/pages/workspace/WorkspaceDesktop.vue:640`);
    });

    it(`retargets a relative markdown link at the workspace route, line tail and all`, () => {
        const link = linkTo(renderMarkdown(`[the config](./src/foo.ts:42)`), `src/foo.ts`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/src/foo.ts`);
        expect(link?.dataset[`line`]).toBe(`42`);
    });

    it(`keeps the prose as the link text when markdown named the file`, () => {
        const link = linkTo(renderMarkdown(`[the config](src/foo.ts)`), `src/foo.ts`);
        expect(link?.textContent).toBe(`the config`);
        expect(link?.getAttribute(`title`)).toBe(`src/foo.ts`);
    });

    it(`maps an absolute container path back to the workspace-relative one`, () => {
        queryData = [{ root: WORKSPACE_ROOT, tree: [] }];
        expect(linkTo(renderMarkdown(`crashed at /work/src/foo.ts:7`), `src/foo.ts`)?.dataset[`line`]).toBe(`7`);
    });

    it(`leaves a path outside the workspace as plain text`, () => {
        queryData = [{ root: WORKSPACE_ROOT, tree: [] }];
        const html = renderMarkdown(`thrown from /usr/lib/node.js:120`);
        expect(html).toContain(`/usr/lib/node.js:120`);
        expect(html).not.toContain(`md-file-link`);
    });

    // Resolved at render time so the href is the real file too, since middle-click and "copy link address" must land
    // where a plain click does. An unmatched reference keeps its literal href and resolves daemon-side on click
    // instead.
    it(`points an abbreviated mention at the file it names`, () => {
        queryData = [
            {
                root: WORKSPACE_ROOT,
                tree: [
                    {
                        name: `_apps`,
                        path: `_apps`,
                        type: `dir`,
                        children: [
                            {
                                name: `pages`,
                                path: `_apps/pages`,
                                type: `dir`,
                                children: [{ name: `Foo.vue`, path: `_apps/pages/Foo.vue`, type: `file` }],
                            },
                        ],
                    },
                ],
            },
        ];
        const link = linkTo(renderMarkdown(`gone from pages/Foo.vue:3`), `_apps/pages/Foo.vue`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/_apps/pages/Foo.vue`);
        expect(link?.dataset[`line`]).toBe(`3`);
        expect(link?.textContent).toBe(`Foo.vue:3`);
    });

    it(`never linkifies inside a fenced code block`, () => {
        const html = renderMarkdown("```ts\nimport x from 'src/foo.ts';\n```");
        expect(html).not.toContain(`md-file-link`);
    });

    it(`sends an outbound link to its own tab so following it can't tear the chat down`, () => {
        const holder = document.createElement(`div`);
        holder.innerHTML = renderMarkdown(`see [the docs](https://example.com/guide.html)`);
        const link = holder.querySelector(`a`);
        expect(link?.getAttribute(`target`)).toBe(`_blank`);
        expect(link?.getAttribute(`rel`)).toBe(`noopener noreferrer`);
        expect(link?.classList.contains(`md-file-link`)).toBe(false);
    });

    it(`still strips active markup: linkifying must not reopen the sanitizer's hole`, () => {
        const html = renderMarkdown(`<img src=x onerror="alert(1)"> and src/foo.ts`);
        expect(html).not.toContain(`onerror`);
        expect(html).toContain(`md-file-link`);
    });
});

// A previewed file resolves neighbours relative to itself, unlike agent prose (always workspace-root-relative);
// resolving it wrong is worse than not linking, since the click lands on the wrong file.
describe(`references inside a previewed document`, () => {
    it(`resolves a relative reference against the document's own directory`, () => {
        const html = renderIn(`docs/`, `see [b](./b.md) and docs/deep/c.md`);
        expect(linkTo(html, `docs/b.md`)).toEqual(expect.any(Object));
        expect(linkTo(html, `docs/docs/deep/c.md`)).toEqual(expect.any(Object));
    });

    it(`walks ../ back up out of the document's directory`, () => {
        expect(linkTo(renderIn(`docs/guides/`, `[root](../../README.md)`), `README.md`)).toEqual(expect.any(Object));
    });

    it(`leaves a root-level document's references alone`, () => {
        expect(linkTo(renderIn(``, `[arch](./ARCHITECTURE.md)`), `ARCHITECTURE.md`)).toEqual(expect.any(Object));
    });

    it(`does not re-root an absolute container path against the document`, () => {
        queryData = [{ root: WORKSPACE_ROOT, tree: [] }];
        expect(linkTo(renderIn(`docs/`, `/work/src/foo.ts`), `src/foo.ts`)).toEqual(expect.any(Object));
    });
});

describe(`links into a conversation's own copy of the workspace`, () => {
    const renderAs = (agent: string, source: string): string => renderEngine(source, fileLinkDecorator({ agent }));

    it(`carries the conversation in the href, so a new tab lands in the same tree`, () => {
        const link = linkTo(renderAs(`c-1`, `Fixed it in src/foo.ts:42 today.`), `src/foo.ts`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/src/foo.ts?agent=c-1`);
        // The click handler reads the dataset; the href covers browser-native gestures instead.
        expect(link?.dataset[`agent`]).toBe(`c-1`);
        expect(link?.dataset[`line`]).toBe(`42`);
    });

    it(`leaves a shared conversation's links unscoped, so nothing changes for them`, () => {
        const link = linkTo(renderMarkdown(`Fixed it in src/foo.ts today.`), `src/foo.ts`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/src/foo.ts`);
        expect(link?.dataset[`agent`]).toBeUndefined();
    });

    it(`unwraps our OWN address written out in full, instead of treating it as another website`, () => {
        const link = linkTo(renderMarkdown(`[the plan](${window.location.origin}/workspace/docs/plan.md#L12)`), `docs/plan.md`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/docs/plan.md`);
        expect(link?.getAttribute(`target`)).toBeNull();
        expect(link?.dataset[`line`]).toBe(`12`);
    });

    it(`scopes an unwrapped full address the same way a bare path is scoped`, () => {
        const link = linkTo(renderAs(`c-1`, `[the plan](${window.location.origin}/workspace/docs/plan.md)`), `docs/plan.md`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/docs/plan.md?agent=c-1`);
    });

    it(`still sends a genuinely external address to its own tab`, () => {
        const holder = document.createElement(`div`);
        holder.innerHTML = renderMarkdown(`see [elsewhere](https://example.com/workspace/docs/plan.md)`);
        const link = holder.querySelector(`a`);
        expect(link?.getAttribute(`target`)).toBe(`_blank`);
        expect(link?.classList.contains(`md-file-link`)).toBe(false);
    });
});
