// Needs jsdom: the decorator works on the sanitized DOM, and DOMPurify needs a real document to build it.
import "@intentic/testing/dom";
import { computed, shallowRef } from "vue";

// The link half of the decorator reads the workspace tree's query for its container root; nothing is in it here.
jest.mock("../queryPersistence", () => ({ queryClient: { getQueriesData: () => [] } }));

const { picturePathIn } = await import("./markdownImages");
const { fileLinkDecorator } = await import("./renderMarkdown");
const { renderMarkdown: renderEngine } = await import("@intentic/ui/markdown");

// What the surface draws a workspace path from: the files asked about, and a URL that lands when the test says so.
// Reactive like the app's picture cache (lazyByPath), since redrawing when the bytes land is part of what is pinned.
const landed = shallowRef<Readonly<Record<string, string>>>({});
const asked: string[] = [];
const draw = (path: string): string | undefined => {
    asked.push(path);
    return landed.value[path];
};

const renderIn = (dir: string, source: string): string => renderEngine(source, fileLinkDecorator({ dir, picture: draw }));

// Every picture's `src` as the document would draw it, in document order.
const sources = (html: string): (string | null)[] => {
    const holder = document.createElement(`div`);
    holder.innerHTML = html;
    return [...holder.querySelectorAll(`img`)].map((image) => image.getAttribute(`src`));
};

beforeEach(() => {
    landed.value = {};
    asked.length = 0;
});

describe(`picturePathIn`, () => {
    it(`resolves a relative picture against the document's folder`, () => {
        expect(picturePathIn(`docs/`, `img/flow.png`)).toBe(`docs/img/flow.png`);
        expect(picturePathIn(`docs/`, `./img/flow.png`)).toBe(`docs/img/flow.png`);
        expect(picturePathIn(`docs/guides/`, `../img/flow.png`)).toBe(`docs/img/flow.png`);
    });

    it(`normalizes a root document's pictures too, rather than taking them as written`, () => {
        expect(picturePathIn(``, `./logo.png`)).toBe(`logo.png`);
        expect(picturePathIn(``, `assets/../logo.png`)).toBe(`logo.png`);
    });

    it(`never climbs out of the workspace, even by one level`, () => {
        expect(picturePathIn(``, `../secret.png`)).toBeUndefined();
        expect(picturePathIn(`docs/`, `../../secret.png`)).toBeUndefined();
        expect(picturePathIn(`docs/`, `img/../../../secret.png`)).toBeUndefined();
        // Up to the root and back down is inside.
        expect(picturePathIn(`docs/`, `../logo.png`)).toBe(`logo.png`);
    });

    it(`leaves every picture with an address of its own alone`, () => {
        for (const src of [
            `https://example.com/a.png`,
            `http://example.com/a.png`,
            `data:image/png;base64,AAAA`,
            `blob:https://app.example/1234`,
            `mailto:someone@example.com`,
            `#figure`,
            `//cdn.example.com/a.png`,
            `/absolute/a.png`,
            ``,
        ]) {
            expect(picturePathIn(`docs/`, src)).toBeUndefined();
        }
    });

    it(`reads the file past a query or a fragment, and decodes an escaped name`, () => {
        expect(picturePathIn(`docs/`, `img/a.png?raw=true`)).toBe(`docs/img/a.png`);
        expect(picturePathIn(`docs/`, `img/a.png#gh-dark-mode-only`)).toBe(`docs/img/a.png`);
        expect(picturePathIn(`docs/`, `img/my%20shot.png`)).toBe(`docs/img/my shot.png`);
        expect(picturePathIn(`docs/`, `img/%E0%A4%A.png`)).toBeUndefined();
    });
});

describe(`pictures in a previewed document`, () => {
    it(`asks for the picture's workspace path, with a neutral src until its bytes land`, () => {
        expect(sources(renderIn(`docs/`, `![flow](img/flow.png)`))).toEqual([``]);
        expect(asked).toEqual([`docs/img/flow.png`]);
    });

    it(`draws the picture once its bytes have landed, and leaves an addressed one as written`, () => {
        landed.value = { "docs/img/flow.png": `blob:app/flow` };
        expect(sources(renderIn(`docs/`, `![flow](img/flow.png) ![web](https://example.com/a.png)`))).toEqual([
            `blob:app/flow`,
            `https://example.com/a.png`,
        ]);
        expect(asked).toEqual([`docs/img/flow.png`]);
    });

    it(`redraws the document when the bytes land, since the render read them`, () => {
        const html = computed(() => renderIn(`docs/`, `![flow](img/flow.png)`));
        expect(sources(html.value)).toEqual([``]);
        landed.value = { "docs/img/flow.png": `blob:app/flow` };
        expect(sources(html.value)).toEqual([`blob:app/flow`]);
    });

    it(`asks for nothing outside the workspace, and draws nothing for it`, () => {
        expect(sources(renderIn(`docs/`, `![x](../../../etc/secret.png)`))).toEqual([``]);
        expect(asked).toEqual([]);
    });

    it(`leaves pictures alone where no folder or no source was given`, () => {
        // Agent prose: nothing to resolve a relative path against.
        expect(sources(renderEngine(`![flow](img/flow.png)`, fileLinkDecorator({ picture: draw })))).toEqual([`img/flow.png`]);
        expect(sources(renderEngine(`![flow](img/flow.png)`, fileLinkDecorator({ dir: `docs/` })))).toEqual([`img/flow.png`]);
        expect(asked).toEqual([]);
    });
});
