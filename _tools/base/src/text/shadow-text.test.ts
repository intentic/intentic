import { markPages, PAGE_MARK_PATTERN } from "./shadow-text.js";

describe("page marks", () => {
    test("every line under a page heading carries its page, heading included", () => {
        expect(markPages("## Page 1\n\nfirst\n\n## Page 12\n\ntwelfth")).toBe("[p. 1] ## Page 1\n[p. 1] \n[p. 1] first\n[p. 1] \n[p. 12] ## Page 12\n[p. 12] \n[p. 12] twelfth");
    });

    test("slides, including a named one, mark by number", () => {
        expect(markPages("## Slide 3: Budget\ntext")).toBe("[slide 3] ## Slide 3: Budget\n[slide 3] text");
    });

    test("text before any heading stays bare, and line count never changes", () => {
        const body = "one page only\nsecond line\n";
        expect(markPages(body)).toBe(body);
        expect(markPages("a\n## Page 2\nb\n").split("\n")).toHaveLength(4);
    });

    test("a heading that only looks like one (## Page two) opens nothing", () => {
        expect(markPages("## Page two\nx")).toBe("## Page two\nx");
        expect(PAGE_MARK_PATTERN.test("[p. 4] x")).toBe(true);
    });
});
