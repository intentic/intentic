import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepUploads, UploadRefused, uploadedFiles, writeUploadPart } from "./upload-store.js";

/* The uploads folder on a real temp tree: parts land in place, a file past its cap is refused and removed, the folder as
   a whole is capped, an old upload is swept, and an answer naming an upload that is not there is refused rather than
   handing the page less than was picked. */

const body = (text: string): ReadableStream<Uint8Array> => new Blob([text]).stream();
const LIMITS = { fileBytes: 10, totalBytes: 15, keepMs: 1000 };

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "browser-uploads-test-"));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("an upload", () => {
    test("arrives in parts, each written where its offset says", async () => {
        const path = await writeUploadPart({ id: "upload-one", name: "notes.txt", offset: 0, body: body("hello") }, root, LIMITS);
        await writeUploadPart({ id: "upload-one", name: "notes.txt", offset: 5, body: body(" you") }, root, LIMITS);
        expect(readFileSync(path, "utf8")).toBe("hello you");
        expect(await uploadedFiles(["upload-one"], root)).toEqual([path]);
    });

    test("past its file cap is refused with 413 and leaves nothing", async () => {
        const refused = writeUploadPart({ id: "upload-big", name: "big.bin", offset: 0, body: body("x".repeat(11)) }, root, LIMITS);
        await expect(refused).rejects.toMatchObject({ status: 413 });
        await expect(uploadedFiles(["upload-big"], root)).rejects.toThrow(UploadRefused);
    });

    test("a later part that would run past the cap is refused too", async () => {
        await writeUploadPart({ id: "upload-two", name: "two.bin", offset: 0, body: body("x".repeat(8)) }, root, LIMITS);
        await expect(writeUploadPart({ id: "upload-two", name: "two.bin", offset: 8, body: body("xxx") }, root, LIMITS)).rejects.toMatchObject({ status: 413 });
    });

    test("a later part with no first part is refused", async () => {
        await expect(writeUploadPart({ id: "upload-none", name: "none.bin", offset: 4, body: body("x") }, root, LIMITS)).rejects.toMatchObject({ status: 404 });
    });

    test("is refused once the folder holds its total", async () => {
        await writeUploadPart({ id: "upload-a1", name: "a.bin", offset: 0, body: body("x".repeat(10)) }, root, LIMITS);
        await writeUploadPart({ id: "upload-a2", name: "b.bin", offset: 0, body: body("x".repeat(5)) }, root, LIMITS);
        await expect(writeUploadPart({ id: "upload-a3", name: "c.bin", offset: 0, body: body("x") }, root, LIMITS)).rejects.toMatchObject({ status: 507 });
    });

    test("is swept once older than it is kept", async () => {
        await writeUploadPart({ id: "upload-old", name: "old.txt", offset: 0, body: body("old") }, root, LIMITS);
        await writeUploadPart({ id: "upload-new", name: "new.txt", offset: 0, body: body("new") }, root, LIMITS);
        const past = (Date.now() - 5000) / 1000;
        utimesSync(join(root, "upload-old"), past, past);
        await sweepUploads(Date.now(), root, LIMITS);
        await expect(uploadedFiles(["upload-old"], root)).rejects.toThrow(UploadRefused);
        expect(await uploadedFiles(["upload-new"], root)).toEqual([join(root, "upload-new", "new.txt")]);
    });
});
