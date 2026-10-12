import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideRel, isInside, realInside, realPathThrough, windowsHolds } from "./contained.js";

describe("isInside", () => {
    it("counts the root itself and anything under it, and nothing beside it", () => {
        expect(isInside("/work/app", "/work/app")).toBe(true);
        expect(isInside("/work/app", "/work/app/src/a.ts")).toBe(true);
        expect(isInside("/work/app", "/work/app-other/a.ts")).toBe(false);
        expect(isInside("/work/app", "/work")).toBe(false);
    });

    // `..notes` is a legal name; only a whole `..` segment climbs.
    it("reads `..x` as a name and `..` as a climb", () => {
        expect(isInside("/work/app", "/work/app/..notes")).toBe(true);
        expect(isInside("/work/app", "/work/app/..")).toBe(false);
        expect(isInside("/work/app", "/work/app/src/../../etc")).toBe(false);
    });

    it("reads Windows paths by Windows rules: another drive is outside, case is ignored", () => {
        const windows = { platform: "win32" } as const;

        expect(isInside("C:\\Users\\me", "D:\\Users\\me\\a", windows)).toBe(false);
        expect(isInside("C:\\Users\\me", "c:\\users\\ME\\code", windows)).toBe(true);
        expect(isInside("C:\\Users\\me", "C:\\Users\\me\\..x", windows)).toBe(true);
    });

    it("ignores case on a POSIX volume only when asked to", () => {
        expect(isInside("/Users/me/Code", "/Users/me/code/app", { platform: "darwin" })).toBe(false);
        expect(isInside("/Users/me/Code", "/Users/me/code/app", { platform: "darwin", foldCase: true })).toBe(true);
    });
});

describe("insideRel", () => {
    it("spells the path under the root with forward slashes, empty for the root", () => {
        expect(insideRel("/work", "/work/a/b")).toBe("a/b");
        expect(insideRel("/work", "/work")).toBe("");
        expect(insideRel("/work", "/elsewhere")).toBeUndefined();
        expect(insideRel("C:\\w", "C:\\w\\a\\b", { platform: "win32" })).toBe("a/b");
    });
});

describe("realInside", () => {
    it("follows a link that leads out and refuses it, and resolves a path not made yet through its parent", async () => {
        const at = realpathSync(mkdtempSync(join(tmpdir(), "contained-")));
        mkdirSync(join(at, "root"));
        mkdirSync(join(at, "outside"));
        symlinkSync(join(at, "outside"), join(at, "root", "link"));

        expect(await realInside(join(at, "root"), join(at, "root", "link", "file"))).toBeUndefined();
        expect(await realInside(join(at, "root"), join(at, "root", "new", "file"))).toBe(join(at, "root", "new", "file"));
        expect(await realPathThrough(join(at, "root", "link", "a"))).toBe(join(at, "outside", "a"));
    });
});

describe("windowsHolds", () => {
    it("refuses what NTFS cannot hold as a name", () => {
        expect(["a.txt:ads", "nul", "COM1.txt", "trailing.", "trailing ", "a\u0001b", "lpt¹"].some(windowsHolds)).toBe(false);
        expect(["notes.txt", "..x", "console.log", "nullable"].every(windowsHolds)).toBe(true);
    });
});
