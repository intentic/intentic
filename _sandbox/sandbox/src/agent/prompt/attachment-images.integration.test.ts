import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAttachments } from "./attachment-images.js";

/* Which attachments a runtime is handed as pictures and which it is told about by path, read off a real temp tree. */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const tree = async (): Promise<{ shot: string; photo: string; gone: string; notes: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "attachment-images-"));
    const shot = join(dir, "shot.png");
    const photo = join(dir, "photo.JPG");
    const notes = join(dir, "notes.md");
    await writeFile(shot, PNG);
    await writeFile(photo, JPEG);
    await writeFile(notes, "# notes");
    return { shot, photo, gone: join(dir, "deleted.png"), notes };
};

test("a runtime that sees pictures gets each readable one as base64 with its type; the rest are named", async () => {
    const { shot, photo, gone, notes } = await tree();
    const attached = await loadAttachments({ attachments: [notes, shot, gone, photo] }, true);

    expect(attached).toEqual({
        images: [
            { path: shot, mimeType: "image/png", data: PNG.toString("base64") },
            { path: photo, mimeType: "image/jpeg", data: JPEG.toString("base64") },
        ],
        unread: [gone],
        pictures: [shot, gone, photo],
        files: [notes],
    });
});

test("a runtime that cannot take pictures reads none, and names every one", async () => {
    const { shot, photo, notes } = await tree();
    const attached = await loadAttachments({ attachments: [shot, notes, photo] }, false);

    expect(attached).toEqual({ images: [], unread: [shot, photo], pictures: [shot, photo], files: [notes] });
});

test("a turn with nothing attached has nothing to load", async () => {
    expect(await loadAttachments({}, true)).toEqual({ images: [], unread: [], pictures: [], files: [] });
});
