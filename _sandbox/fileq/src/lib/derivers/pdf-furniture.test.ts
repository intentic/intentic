import { stripRunningFurniture } from "./pdf-furniture.js";

const WORDS = ["", "alpha", "beta", "gamma", "delta", "epsilon"];

// Page n of a printed RFC: body text between the header and footer it repeats on every page.
const page = (n: number, body: string): string =>
    [
        "RFC 9110 HTTP Semantics June 2022",
        body,
        `More of the ${WORDS[n]} part.`,
        `The last line of ${WORDS[n]}.`,
        `Fielding, et al. Standards Track [Page ${n}]`,
    ].join("\n");

describe("stripRunningFurniture", () => {
    test("removes a running header and a numbered footer, keeping every body line", () => {
        const pages = [1, 2, 3, 4, 5].map((n) => page(n, `Body of ${WORDS[n]}.`));
        const { pages: kept, removed, example } = stripRunningFurniture(pages);
        expect(removed).toBe(10);
        expect(example).toBe("RFC 9110 HTTP Semantics June 2022");
        expect(kept[2]).toBe("Body of gamma.\nMore of the gamma part.\nThe last line of gamma.");
    });

    test("removes bare page numbers only when they count with the pages", () => {
        const counted = ["alpha", "beta", "gamma", "delta"].map((word, index) => `${word} one\n${word} two\n${word} three\n${index + 3}`);
        expect(stripRunningFurniture(counted).pages[0]).toBe("alpha one\nalpha two\nalpha three");
        // A table whose last value happens to sit at the page edge is data, not a folio.
        const values = ["alpha", "beta", "gamma", "delta"].map((word, index) => `${word} one\n${word} two\n${word} three\n${[42, 17, 42, 9][index]}`);
        expect(stripRunningFurniture(values).removed).toBe(0);
    });

    test("removes self-describing page numbers even where nothing else recurs", () => {
        const pages = ["a", "b", "c", "d"].map((word, index) => `${word} first\n${word} middle\n${word} last\n- ${index + 1} -`);
        expect(stripRunningFurniture(pages).pages.every((text) => !text.includes("-"))).toBe(true);
    });

    test("leaves short documents and non-recurring edge lines alone", () => {
        const short = [1, 2, 3].map((n) => page(n, "body"));
        expect(stripRunningFurniture(short)).toEqual({ pages: short, removed: 0, example: undefined });
        const distinct = ["One", "Two", "Three", "Four"].map((word) => `${word} heading\n${word} body\n${word} more\nclosing ${word}`);
        expect(stripRunningFurniture(distinct).removed).toBe(0);
        // The same line at the top of some pages and the bottom of others is running at neither edge.
        const wandering = ["a", "b", "c", "d"].map((word, index) =>
            index % 2 === 0 ? `See also\n${word} x\n${word} y\n${word} z` : `${word} x\n${word} y\n${word} z\nSee also`,
        );
        expect(stripRunningFurniture(wandering).removed).toBe(0);
        // Numbered content that does not count with the pages is not a running line.
        const questions = [3, 7, 8, 12].map((n) => `Question ${n}\nWhat is ${n} squared?\nShow ${n} steps.\nAnswer ${n}: ____`);
        expect(stripRunningFurniture(questions).removed).toBe(0);
    });

    test("a page holding only furniture comes back empty, and the others keep their places", () => {
        const pages = [1, 2, 3, 4, 5].map((n) => page(n, `Body of ${WORDS[n]}.`));
        pages[3] = "RFC 9110 HTTP Semantics June 2022\nFielding, et al. Standards Track [Page 4]";
        const { pages: kept } = stripRunningFurniture(pages);
        expect(kept).toHaveLength(5);
        expect(kept[3]).toBe("");
        expect(kept[4]).toBe("Body of epsilon.\nMore of the epsilon part.\nThe last line of epsilon.");
    });
});
