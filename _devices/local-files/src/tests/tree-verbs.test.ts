import { posix, win32 } from "node:path";
import { intoItself } from "../tree-verbs.js";

// Where a move or a copy would land inside what it moves, by each platform's own path rules.

describe(`intoItself`, () => {
    // One path to Windows, where names compare without case: a rename, never a move into itself.
    it(`takes a rename to another case of the same name for a rename, on Windows`, () => {
        expect(intoItself(`C:\\Users\\me\\project\\Report.docx`, `C:\\Users\\me\\project\\report.docx`, win32)).toBe(false);
        expect(intoItself(`C:\\Users\\me\\project\\Docs`, `C:\\Users\\me\\project\\docs`, win32)).toBe(false);
    });

    it(`finds a destination inside the entry, whatever the case it is spelled in`, () => {
        expect(intoItself(`C:\\Users\\me\\project\\docs`, `C:\\Users\\me\\project\\DOCS\\drafts\\docs`, win32)).toBe(true);
        expect(intoItself(`/home/me/project/docs`, `/home/me/project/docs/drafts/docs`, posix)).toBe(true);
        expect(intoItself(`/home/me/project/docs`, `/home/me/project/docs/docs`, posix)).toBe(true);
    });

    it(`lets an entry go beside itself or anywhere else`, () => {
        expect(intoItself(`/home/me/project/docs`, `/home/me/project/docs-old`, posix)).toBe(false);
        expect(intoItself(`/home/me/project/docs`, `/home/me/project/archive/docs`, posix)).toBe(false);
        expect(intoItself(`/home/me/project/a.md`, `/home/me/project/a.md`, posix)).toBe(false);
    });
});
