import { describe, test, expect } from "bun:test";
import { gzipHead, looksLikeTar, parseTarListing, tarEntries, zipEntries } from "./archives.js";
import { gzipBytes, tarBytes, zipBytes } from "../testing.js";

// The readers, against archives built in code. What each test pins is the shape an archive's index has to arrive in;
// the external lister is pinned through its parser, since whether the box has GNU tar is not this suite's business.

describe("zip", () => {
    test("every member is enumerated with both sizes, nothing inflated", () => {
        const entries = zipEntries(zipBytes({ "README.md": "# hello", "src/index.ts": "export const x = 1;\n".repeat(40) }));
        expect(entries.map((entry) => entry.path)).toEqual(["README.md", "src/index.ts"]);
        const index = entries[1];
        expect(index?.size).toBe(800);
        // Deflate earns its keep on repeated text: the packed side has to be the smaller of the two.
        expect(index?.packed).toBeLessThan(index?.size ?? 0);
    });

    test("a folder entry is marked as one", () => {
        expect(zipEntries(zipBytes({ "docs/": "", "docs/a.txt": "a" })).map((entry) => entry.directory)).toEqual([true, false]);
    });
});

describe("tar", () => {
    test("members come back in archive order, with their sizes", () => {
        const entries = tarEntries(tarBytes({ "notes.txt": "hello", "data/rows.csv": "a,b\n1,2\n" }));
        expect(entries.map((entry) => [entry.path, entry.size])).toEqual([
            ["notes.txt", 5],
            ["data/rows.csv", 8],
        ]);
    });

    test("a path too long for the name field survives the block that carries it", () => {
        const long = `deep/${"nested/".repeat(20)}file.txt`;
        expect(tarEntries(tarBytes({ [long]: "x" })).map((entry) => entry.path)).toEqual([long]);
    });

    test("a file that is not a tar is refused rather than read as empty", () => {
        expect(() => tarEntries(new TextEncoder().encode("just some text, not an archive at all"))).toThrow(/not a tar/);
        expect(looksLikeTar(new Uint8Array(600))).toBe(false);
    });
});

describe("gzip", () => {
    test("the header names the member and the trailer sizes it, without inflating", () => {
        const head = gzipHead(gzipBytes("server.log", "x".repeat(1000)));
        expect(head?.name).toBe("server.log");
        expect(head?.unpackedBytes).toBe(1000);
    });

    test("bytes that are not gzip answer nothing", () => {
        expect(gzipHead(new Uint8Array([1, 2, 3]))).toBeUndefined();
    });
});

describe("the external listing parser", () => {
    test("mode, size and path are read off each row, spaces in names included", () => {
        const stdout = [
            "drwxr-xr-x root/root         0 2024-03-01 09:15 site/",
            "-rw-r--r-- root/root      2048 2024-03-01 09:15 site/my notes.txt",
            "lrwxrwxrwx root/root         0 2024-03-01 09:15 site/link -> site/my notes.txt",
            "",
        ].join("\n");
        expect(parseTarListing(stdout)).toEqual([
            { path: "site/", size: undefined, packed: undefined, directory: true },
            { path: "site/my notes.txt", size: 2048, packed: undefined, directory: false },
            { path: "site/link", size: 0, packed: undefined, directory: false },
        ]);
    });

    test("anything that is not a listing row is skipped, so a warning on stderr's twin cannot become a member", () => {
        expect(parseTarListing("tar: Removing leading `/' from member names\n")).toEqual([]);
    });
});
