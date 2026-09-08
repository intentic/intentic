// @vitest-environment jsdom
// Arithmetic behind the markdown preview's outline rail: which section is active, which headings exist.
import { describe, expect, it } from "vitest";
import { activeAt, matchHeadings, progressAt, readHeadings, type OutlineHeading } from "./markdownOutline";

const container = (html: string): HTMLElement => {
    const view = document.createElement(`div`);
    view.innerHTML = html;
    return view;
};

describe(`readHeadings`, () => {
    it(`reads level and words in document order`, () => {
        const view = container(`<h1>Five extensions</h1><p>text</p><h2>Publishing one</h2><h3>Tests</h3>`);
        expect(readHeadings(view)).toEqual([
            { level: 1, text: `Five extensions` },
            { level: 2, text: `Publishing one` },
            { level: 3, text: `Tests` },
        ]);
    });

    it(`flattens inline markup and whitespace into one line`, () => {
        const view = container(`<h2>\n  <code>api.views</code>\n  — the\n  surfaces\n</h2>`);
        expect(readHeadings(view)).toEqual([{ level: 2, text: `api.views — the surfaces` }]);
    });

    it(`skips headings with no words in them`, () => {
        const view = container(`<h1></h1><h2>  </h2><h3>Real</h3>`);
        expect(readHeadings(view)).toEqual([{ level: 3, text: `Real` }]);
    });

    it(`stops at h4`, () => {
        const view = container(`<h4>Kept</h4><h5>Dropped</h5><h6>Dropped</h6>`);
        expect(readHeadings(view)).toEqual([{ level: 4, text: `Kept` }]);
    });

    it(`finds headings inside figure runs, which are nested a level deeper`, () => {
        const view = container(`<div class="md-run"><h2>Before</h2></div><figure>fig</figure><div class="md-run"><h2>After</h2></div>`);
        expect(readHeadings(view).map((heading) => heading.text)).toEqual([`Before`, `After`]);
    });
});

describe(`activeAt`, () => {
    const tops = [0, 500, 1200];

    it(`names the first section before anything has scrolled`, () => {
        expect(activeAt(tops, 0, false)).toBe(0);
    });

    it(`switches only once the next heading is past the line`, () => {
        expect(activeAt(tops, 400, false)).toBe(0);
        expect(activeAt(tops, 440, false)).toBe(1);
    });

    // A short last section can't scroll to its own top; `atBottom` must still select it.
    it(`names the last section at the bottom of the document`, () => {
        expect(activeAt(tops, 900, true)).toBe(2);
    });

    it(`has no answer for a document with no headings`, () => {
        expect(activeAt([], 0, false)).toBe(-1);
        expect(activeAt([], 0, true)).toBe(-1);
    });
});

describe(`progressAt`, () => {
    it(`runs 0 to 1 across the scrollable travel`, () => {
        expect(progressAt(0, 2000, 1000)).toBe(0);
        expect(progressAt(500, 2000, 1000)).toBe(0.5);
        expect(progressAt(1000, 2000, 1000)).toBe(1);
    });

    it(`calls a document that fits fully read`, () => {
        expect(progressAt(0, 800, 1000)).toBe(1);
    });

    // Rubber-banding at either end reports a scrollTop outside the travel.
    it(`clamps past either end`, () => {
        expect(progressAt(-40, 2000, 1000)).toBe(0);
        expect(progressAt(1400, 2000, 1000)).toBe(1);
    });
});

describe(`matchHeadings`, () => {
    const headings: OutlineHeading[] = [
        { level: 1, text: `Five extensions, five repos` },
        { level: 2, text: `Publishing one` },
        { level: 2, text: `What is still uncovered` },
    ];

    it(`keeps everything for an empty query`, () => {
        expect(matchHeadings(headings, `  `).map((row) => row.index)).toEqual([0, 1, 2]);
    });

    it(`matches anywhere in a heading, ignoring case`, () => {
        expect(matchHeadings(headings, `PUBLISH`).map((row) => row.heading.text)).toEqual([`Publishing one`]);
    });

    it(`carries each survivor's document position, not its place in the results`, () => {
        expect(matchHeadings(headings, `uncovered`)).toEqual([{ heading: headings[2], index: 2 }]);
    });
});
