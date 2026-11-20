import { safeFileName } from "../downloads/download-files.js";
import { UploadRefused, uploadPath } from "./upload-store.js";

/* Where an upload for a page may land: one folder per upload under the uploads root, named by the uploader's id, and a
   file named after the person's own, made safe. Nothing either side sends can put a file anywhere else. */

const ROOT = "/tmp/intentic-browser-uploads";

describe("an upload's place", () => {
    test("is the root, the upload's own folder, and its file", () => {
        expect(uploadPath(ROOT, "abcd1234", "report.pdf")).toBe(`${ROOT}/abcd1234/report.pdf`);
    });

    test("an id that is not one plain segment is refused", () => {
        for (const id of ["../etc", "short", "a/b/c/d/e", "abcd1234/..", "x".repeat(65), "abc 1234"]) {
            expect(() => uploadPath(ROOT, id, "file.txt")).toThrow(UploadRefused);
        }
    });

    test("a name cannot climb out or hide", () => {
        expect(uploadPath(ROOT, "abcd1234", "../../etc/passwd")).toBe(`${ROOT}/abcd1234/_.._etc_passwd`);
        expect(uploadPath(ROOT, "abcd1234", "..")).toBe(`${ROOT}/abcd1234/download`);
        expect(uploadPath(ROOT, "abcd1234", ".bashrc")).toBe(`${ROOT}/abcd1234/bashrc`);
        expect(uploadPath(ROOT, "abcd1234", "a\\b\u0000c")).toBe(`${ROOT}/abcd1234/a_b_c`);
    });
});

describe("a file name made safe", () => {
    test("keeps an ordinary name as it is", () => {
        expect(safeFileName("Quarterly report (final).pdf")).toBe("Quarterly report (final).pdf");
    });

    test("an empty or all-dots name is a plain download", () => {
        expect(safeFileName("")).toBe("download");
        expect(safeFileName("...")).toBe("download");
    });

    test("a long name is cut at 200 characters", () => {
        expect(safeFileName("a".repeat(300))).toHaveLength(200);
    });
});
