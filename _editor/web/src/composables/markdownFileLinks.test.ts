// @vitest-environment jsdom
//
// Both the linkifier and DOMPurify need a real document (see renderMarkdown.test.ts for why jsdom rather than
// happy-dom). Asserted end-to-end through renderMarkdown, because the seam being pinned is the ORDER — marked
// parses, DOMPurify sanitizes, then the file links go in — and a unit test of the walker alone would not catch
// it moving.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The container-root lookup reads the workspace-tree query; `queryData` is that seam.
let queryData: { root?: string; tree?: unknown[] }[] = [];
vi.mock("./queryPersistence", () => ({
    queryClient: { getQueriesData: () => queryData.map((data) => [[], data] as const) },
}));

const { fileLinkDecorator, renderMarkdown } = await import("./renderMarkdown");
const { renderMarkdown: renderEngine } = await import("@intentic/ui/markdown");

// A previewed FILE renders through the kit's <Markdown> with the app's decorator (see MarkdownViewer), which is
// the only surface that knows a directory to resolve against — so the document cases below go in the same way.
const renderIn = (dir: string, source: string): string => renderEngine(source, fileLinkDecorator(dir));

beforeEach(() => {
    queryData = [];
});

// The rendered anchor for `path`, or undefined — parsed back out of the HTML so the assertions read as "what
// the DOM ends up being" rather than as string matching.
const linkTo = (html: string, path: string): HTMLAnchorElement | undefined => {
    const holder = document.createElement(`div`);
    holder.innerHTML = html;
    return holder.querySelector<HTMLAnchorElement>(`a[data-file="${path}"]`) ?? undefined;
};

describe(`file mentions in agent prose`, () => {
    it(`linkifies a bare path, carrying the workspace route and the line`, () => {
        const link = linkTo(renderMarkdown(`Fixed it in src/foo.ts:42 today.`), `src/foo.ts`);
        // Shown by filename — the path is addressing, and it stays in the href and the tooltip.
        expect(link?.textContent).toBe(`foo.ts:42`);
        expect(link?.getAttribute(`title`)).toBe(`src/foo.ts:42`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/src/foo.ts`);
        expect(link?.dataset[`line`]).toBe(`42`);
        expect(link?.classList.contains(`md-file-link`)).toBe(true);
    });

    it(`linkifies a path in backticks — the form agents reach for most`, () => {
        const html = renderMarkdown("See the `src/chat/useChat.ts` singleton.");
        const link = linkTo(html, `src/chat/useChat.ts`);
        expect(link).toBeDefined();
        // The inline-code styling survives: the anchor goes INSIDE the <code>, not around it.
        expect(link?.closest(`code`)).not.toBeNull();
    });

    // Nothing asks the model for a notation, so every one it might reach for has to land on the same link.
    it(`reads the line off whichever notation the reference arrived in`, () => {
        const forms = [`src/foo.ts:42`, `src/foo.ts(42,7)`, `[the config](src/foo.ts#L42)`, `[the config](src/foo.ts#L42-L58)`];
        for (const form of forms) {
            expect(linkTo(renderMarkdown(form), `src/foo.ts`)?.dataset[`line`]).toBe(`42`);
        }
    });

    it(`shows a deep path by its filename — the sentence stays readable, the link still lands`, () => {
        const link = linkTo(
            renderMarkdown(`gone from _editor/web/src/pages/workspace/WorkspaceDesktop.vue:640`),
            `_editor/web/src/pages/workspace/WorkspaceDesktop.vue`,
        );
        expect(link?.textContent).toBe(`WorkspaceDesktop.vue:640`);
        expect(link?.getAttribute(`title`)).toBe(`_editor/web/src/pages/workspace/WorkspaceDesktop.vue:640`);
    });

    it(`retargets a relative markdown link at the workspace route, line tail and all`, () => {
        // Left alone this would be a browser navigation to a relative URL the SPA has no route for.
        const link = linkTo(renderMarkdown(`[the config](./src/foo.ts:42)`), `src/foo.ts`);
        expect(link?.getAttribute(`href`)).toBe(`/workspace/src/foo.ts`);
        expect(link?.dataset[`line`]).toBe(`42`);
    });

    it(`keeps the prose as the link text when markdown named the file`, () => {
        const link = linkTo(renderMarkdown(`[the config](src/foo.ts)`), `src/foo.ts`);
        expect(link?.textContent).toBe(`the config`);
        // The path is only visible on hover, so it has to be in the tooltip.
        expect(link?.getAttribute(`title`)).toBe(`src/foo.ts`);
    });

    it(`maps an absolute container path back to the workspace-relative one`, () => {
        queryData = [{ root: `/work`, tree: [] }];
        expect(linkTo(renderMarkdown(`crashed at /work/src/foo.ts:7`), `src/foo.ts`)?.dataset[`line`]).toBe(`7`);
    });

    it(`leaves a path outside the workspace as plain text`, () => {
        queryData = [{ root: `/work`, tree: [] }];
        const html = renderMarkdown(`thrown from /usr/lib/node.js:120`);
        expect(html).toContain(`/usr/lib/node.js:120`);
        expect(html).not.toContain(`md-file-link`);
    });

    // Resolved at RENDER time so the href is the real file too: ⌘-click and "copy link address" have to land
    // where a plain click does. A reference the cached tree can't place keeps its literal href and is resolved
    // daemon-side on click instead (see openFileRef.test.ts).
    it(`points an abbreviated mention at the file it names`, () => {
        queryData = [
            {
                root: `/work`,
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

    it(`still strips active markup — linkifying must not reopen the sanitizer's hole`, () => {
        const html = renderMarkdown(`<img src=x onerror="alert(1)"> and src/foo.ts`);
        expect(html).not.toContain(`onerror`);
        expect(html).toContain(`md-file-link`);
    });
});

/* A markdown FILE names its neighbours relative to itself, so the same reference means a different file
 * depending on where the document lives — the distinction agent prose (always workspace-root-relative) does
 * not have. Resolving it wrong is worse than not linking at all: the click lands on a file that isn't there. */
describe(`references inside a previewed document`, () => {
    it(`resolves a relative reference against the document's own directory`, () => {
        const html = renderIn(`docs/`, `see [b](./b.md) and docs/deep/c.md`);
        expect(linkTo(html, `docs/b.md`)).toBeDefined();
        expect(linkTo(html, `docs/docs/deep/c.md`)).toBeDefined();
    });

    it(`walks ../ back up out of the document's directory`, () => {
        expect(linkTo(renderIn(`docs/guides/`, `[root](../../README.md)`), `README.md`)).toBeDefined();
    });

    it(`leaves a root-level document's references alone`, () => {
        expect(linkTo(renderIn(``, `[arch](./ARCHITECTURE.md)`), `ARCHITECTURE.md`)).toBeDefined();
    });

    it(`does not re-root an absolute container path against the document`, () => {
        queryData = [{ root: `/work`, tree: [] }];
        expect(linkTo(renderIn(`docs/`, `/work/src/foo.ts`), `src/foo.ts`)).toBeDefined();
    });
});
