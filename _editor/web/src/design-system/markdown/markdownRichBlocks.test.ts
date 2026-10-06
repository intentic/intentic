// The editing surface's blocks that draw rendered at rest (raw HTML, pictures, inline tags): what fills their holders,
// how an HTML container's alignment carries across the blocks it wraps, and which blocks draw nothing and so stay as
// quiet source. jsdom, since the renderings are sanitized into a real document.
import "@intentic/testing/dom";
import { buildBlockElement, blockBody, splitMarkdownBlocks } from "@intentic/ui/markdown";
import { alignContainers, createRenderedDrawing } from "../../../../ui/src/components/markdown/richBlocks.js";

// A document laid out the way the surface lays it out: one element per block, under one root.
const layout = (source: string) => {
    const { blocks, defs } = splitMarkdownBlocks(source);
    const root = document.createElement(`div`);
    const built = blocks.map((block) => {
        const body = source.slice(block.start, block.end).replace(/\n*$/u, ``);
        const element = buildBlockElement(body);
        root.append(element);
        return { body, element };
    });
    return { root, blocks: built, defs };
};

const README = `<div align="center">

<a href="https://intentic.dev"><img src="https://x.dev/logo.svg" alt="logo"></a>

<h1>intentic</h1>

Some **markdown** in between.

</div>

## After

Plain prose.
`;

describe(`alignContainers`, () => {
    test(`a container's alignment holds for every block it wraps, and stops where it closes`, () => {
        const { blocks } = layout(README);
        alignContainers(blocks);
        expect(blocks.map((block) => block.element.dataset[`mdAlign`])).toEqual([undefined, `center`, `center`, `center`, `center`, undefined, undefined]);
    });

    test(`a block that opens and closes its own container leaves the next one alone`, () => {
        const { blocks } = layout(`<p align="center">\n  <img src="a.png">\n</p>\n\nAfter.\n`);
        alignContainers(blocks);
        expect(blocks.map((block) => block.element.dataset[`mdAlign`])).toEqual([undefined, undefined]);
    });

    test(`<center> and a text-align style count; a container with no alignment does not inherit a wrong one`, () => {
        const { blocks } = layout(`<center>\n\nA\n\n</center>\n\n<div style="text-align: right">\n\nB\n\n<div>\n\nC\n\n</div>\n\n</div>\n`);
        alignContainers(blocks);
        expect(blocks.map((block) => [block.body, block.element.dataset[`mdAlign`]])).toEqual([
            [`<center>`, undefined],
            [`A`, `center`],
            [`</center>`, `center`],
            [`<div style="text-align: right">`, undefined],
            [`B`, `right`],
            [`<div>`, `right`],
            [`C`, `right`],
            [`</div>`, `right`],
            [`</div>`, `right`],
        ]);
    });
});

describe(`createRenderedDrawing`, () => {
    test(`fills each holder with the block as the rendered document draws it`, () => {
        const { root } = layout(README);
        createRenderedDrawing(() => undefined).draw(root, ``);
        const holders = [...root.querySelectorAll<HTMLElement>(`.md-rendered`)];
        expect(holders.some((holder) => holder.querySelector(`img[alt="logo"]`) !== null)).toBe(true);
        expect(holders.some((holder) => holder.querySelector(`h1`)?.textContent === `intentic`)).toBe(true);
    });

    test(`a block that draws nothing is marked quiet, so its source stays on the page`, () => {
        const { root, blocks } = layout(README);
        createRenderedDrawing(() => undefined).draw(root, ``);
        const quiet = blocks.filter((block) => block.element.hasAttribute(`data-md-quiet`)).map((block) => block.body);
        expect(quiet).toEqual([`<div align="center">`, `</div>`]);
    });

    test(`a picture by reference resolves against the document's definitions`, () => {
        const source = `[![ci][badge]][ci] passing.\n\n[badge]: https://img.example/b.svg\n[ci]: https://ci.example/\n`;
        const { root, blocks, defs } = layout(source);
        // The definitions fold into the block above them, and still read back as the file.
        expect(blocks).toHaveLength(1);
        expect(blockBody(blocks[0]!.element)).toBe(source.trimEnd());
        createRenderedDrawing(() => undefined).draw(root, defs);
        const image = root.querySelector<HTMLImageElement>(`.md-rendered img`);
        expect(image?.getAttribute(`src`)).toBe(`https://img.example/b.svg`);
        expect(image?.closest(`a`)?.getAttribute(`href`)).toBe(`https://ci.example/`);
    });

    test(`runs the decorator over every rendering`, () => {
        const { root } = layout(`<p><img src="a.png" alt="x"></p>\n`);
        createRenderedDrawing(() => (fragment) => {
            for (const image of fragment.querySelectorAll(`img`)) {
                image.setAttribute(`src`, `blob:resolved`);
            }
        }).draw(root, ``);
        expect(root.querySelector(`.md-rendered img`)?.getAttribute(`src`)).toBe(`blob:resolved`);
    });
});
