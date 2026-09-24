import { mkdtempSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWatermark, resumePoint, watermarkPath, writeWatermark } from "./watermark.js";

const current = { mailbox: "INBOX", uidValidity: "111", uidNext: 500 };

test("resumePoint baselines at the current end when nothing is stored", () => {
    expect(resumePoint(undefined, current)).toEqual({ lastUid: 499, baselined: true });
});

test("resumePoint re-baselines on a UIDVALIDITY reset or a changed watched mailbox", () => {
    expect(resumePoint({ mailbox: "INBOX", uidValidity: "222", lastUid: 400 }, current)).toEqual({ lastUid: 499, baselined: true });
    expect(resumePoint({ mailbox: "Archive", uidValidity: "111", lastUid: 400 }, current)).toEqual({ lastUid: 499, baselined: true });
});

test("resumePoint resumes from the stored uid when the mailbox generation matches", () => {
    expect(resumePoint({ mailbox: "INBOX", uidValidity: "111", lastUid: 400 }, current)).toEqual({ lastUid: 400, baselined: false });
});

test("watermark roundtrips through its file; missing and corrupt files read as absent, the corrupt ones reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "imap-mark-"));
    const path = watermarkPath(root, "work");
    const reported: string[] = [];
    const report = (detail: string): void => void reported.push(detail);
    expect(await readWatermark(path, report)).toBeUndefined();
    expect(reported).toEqual([]);

    const mark = { mailbox: "INBOX", uidValidity: "9007199254740993", lastUid: 42 };
    await writeWatermark(path, mark);
    expect(await readWatermark(path, report)).toEqual(mark);

    await writeFile(path, "{not json");
    expect(await readWatermark(path, report)).toBeUndefined();
    await writeFile(path, JSON.stringify({ mailbox: "INBOX", uidValidity: 111, lastUid: 42 }));
    expect(await readWatermark(path, report)).toBeUndefined();
    expect(reported).toEqual([expect.stringMatching(/^not JSON: /), "not a watermark: mailbox, uidValidity or lastUid is missing or mistyped"]);
});

/* A MARK THAT COULD NOT BE READ IS NOT A MISSING ONE: reading it as absent re-baselines, and the baseline is written over
 * it, so every message from the downtime would be skipped without a word. */
test("readWatermark throws on a read that failed rather than reading it as no watermark", async () => {
    const root = mkdtempSync(join(tmpdir(), "imap-mark-"));
    const path = watermarkPath(root, "work");
    await mkdir(path, { recursive: true });
    await expect(readWatermark(path, () => undefined)).rejects.toMatchObject({ code: "EISDIR" });
});

test("writeWatermark leaves nothing staged beside the mark", async () => {
    const root = mkdtempSync(join(tmpdir(), "imap-mark-"));
    const path = watermarkPath(root, "work");
    await writeWatermark(path, { mailbox: "INBOX", uidValidity: "1", lastUid: 1 });
    await writeWatermark(path, { mailbox: "INBOX", uidValidity: "1", lastUid: 2 });
    expect(await readdir(join(path, ".."))).toEqual(["work.json"]);
    expect(await readWatermark(path, () => undefined)).toEqual({ mailbox: "INBOX", uidValidity: "1", lastUid: 2 });
});

test("watermarkPath keeps the file under the runtime tree and sanitizes the id", () => {
    expect(watermarkPath("/work", "my-inbox")).toBe("/work/.intentic/local/runtime/extensions/imap/my-inbox.json");
    expect(watermarkPath("/work", "../escape me")).toBe("/work/.intentic/local/runtime/extensions/imap/.._escape_me.json");
});
