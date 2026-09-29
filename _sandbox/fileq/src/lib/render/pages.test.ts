import { BadPages, describePages, pagesWithin, parsePages, runsOf } from "./pages.js";

describe("parsePages", () => {
    test("a page, a range, an open range and a list", () => {
        expect(parsePages("3")).toEqual([{ from: 3, to: 3 }]);
        expect(parsePages("1-3")).toEqual([{ from: 1, to: 3 }]);
        expect(parsePages("7-")).toEqual([{ from: 7, to: undefined }]);
        expect(parsePages("2, 5,7-9")).toEqual([
            { from: 2, to: 2 },
            { from: 5, to: 5 },
            { from: 7, to: 9 },
        ]);
    });

    test("page 0, a backwards range and words are refused with the reason", () => {
        expect(() => parsePages("0")).toThrow(BadPages);
        expect(() => parsePages("5-2")).toThrow("pages count from 1, and a range runs forward");
        expect(() => parsePages("first")).toThrow('--pages takes numbers and ranges like 1-3,5,7-; "first" is neither');
    });
});

describe("pagesWithin", () => {
    test("ranges are clipped to the document, merged, sorted, each page once", () => {
        expect(pagesWithin(parsePages("4-,2,3-5"), 6)).toEqual([2, 3, 4, 5, 6]);
        expect(pagesWithin(parsePages("8-10"), 6)).toEqual([]);
    });
});

describe("runsOf and describePages", () => {
    test("consecutive pages form one run, for the rasterizer and for the message", () => {
        expect(runsOf([1, 2, 3, 5, 7, 8])).toEqual([
            [1, 3],
            [5, 5],
            [7, 8],
        ]);
        expect(describePages([1, 2, 3, 5, 7, 8])).toBe("1-3, 5, 7-8");
    });
});
