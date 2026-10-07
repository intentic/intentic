import type { FileEntry, RankedGroup } from "../types.js";
import { SIBLINGS_SHOWN, siblingsLine } from "./siblings.js";

const entry = (path: string): FileEntry => ({ path, abs: `/w/${path}`, mtimeMs: 0, size: 1 });
const group = (path: string): RankedGroup => ({ path, score: 1, hits: [] });

const FOLDER = [
    "web/src/chat/ChatImageThumb.vue",
    "web/src/chat/ChatImageThumb.test.ts",
    "web/src/chat/pictureQuickLook.ts",
    "web/src/chat/README.md",
    "web/src/chat/thumb.svg.json",
    "web/src/chat/composer/Composer.vue",
    "web/src/other/picture.ts",
].map(entry);

describe("siblingsLine", () => {
    // The case that motivated it: the answer was ChatImageThumb.vue, the file the session edited was pictureQuickLook.ts.
    test("names the answer's neighbours, source and tests only, not its subfolders or docs", () => {
        expect(siblingsLine("web/src/chat/ChatImageThumb.vue", FOLDER, [], "thumb")).toBe("siblings: ChatImageThumb.test.ts · pictureQuickLook.ts");
    });

    test("ranked neighbours come first in rank order, then the ones whose name holds the query's words", () => {
        expect(siblingsLine("web/src/chat/ChatImageThumb.vue", FOLDER, [group("web/src/chat/pictureQuickLook.ts")], "thumb")).toBe(
            "siblings: pictureQuickLook.ts · ChatImageThumb.test.ts",
        );
        expect(siblingsLine("web/src/chat/ChatImageThumb.vue", FOLDER, [], "a quick look at a picture")).toBe("siblings: pictureQuickLook.ts · ChatImageThumb.test.ts");
    });

    test("a long folder is capped and the rest counted", () => {
        const many = Array.from({ length: 10 }, (unused, index) => entry(`src/m/file${index}.ts`));
        const line = siblingsLine("src/m/file0.ts", many, [], "x");
        expect(line?.split(" · ")).toHaveLength(SIBLINGS_SHOWN + 1);
        expect(line).toMatch(/· \+3 more$/);
    });

    test("nothing to name for a root file or a file alone in its folder", () => {
        expect(siblingsLine("README.md", FOLDER, [], "x")).toBeUndefined();
        expect(siblingsLine("web/src/other/picture.ts", FOLDER, [], "x")).toBeUndefined();
    });
});
