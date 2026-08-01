import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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

test("watermark roundtrips through its file; missing and corrupt files read as absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "imap-mark-"));
    const path = watermarkPath(root, "work");
    expect(await readWatermark(path)).toBeUndefined();

    const mark = { mailbox: "INBOX", uidValidity: "9007199254740993", lastUid: 42 };
    await writeWatermark(path, mark);
    expect(await readWatermark(path)).toEqual(mark);

    await writeFile(path, "{not json");
    expect(await readWatermark(path)).toBeUndefined();
    await writeFile(path, JSON.stringify({ mailbox: "INBOX", uidValidity: 111, lastUid: 42 }));
    expect(await readWatermark(path)).toBeUndefined();
});

test("watermarkPath keeps the file under the runtime tree and sanitizes the id", () => {
    expect(watermarkPath("/work", "my-inbox")).toBe("/work/.intentic/extensions-runtime/imap/my-inbox.json");
    expect(watermarkPath("/work", "../escape me")).toBe("/work/.intentic/extensions-runtime/imap/.._escape_me.json");
});
