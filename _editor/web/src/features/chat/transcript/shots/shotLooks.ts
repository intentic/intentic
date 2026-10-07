import { STATE_DIR } from "@intentic/constants";
import { lazyByPath } from "../../../../client/sandbox/lazyByPath";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";
import { renditionBlob } from "../../../workspace/home/thumbnails";
import { lookOf, type ShotLook, UNJUDGED } from "./shotLook";

// Each shot's look (shotLook.ts), read off the daemon's `tile` rendition: the whole picture inside 256 px, a few KB,
// where the strip's rendition is cut from the top and would call a tall page plain for its empty header.

// Final answers about the file (bad path, no access, gone, cleaned up, too big, not a picture the daemon re-encodes):
// such a shot is judged nothing, so it shows as it would have. Anything else is lazyByPath's to retry.
const FINAL = new Set([400, 403, 404, 412, 413, 415]);

// The rendition's pixels. An engine with no way to decode onto a surface (jsdom has neither global) throws, which
// judge() takes as a picture it cannot judge.
const pixelsOf = async (blob: Blob): Promise<ImageData | undefined> => {
    const bitmap = await createImageBitmap(blob);
    try {
        const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext(`2d`, { willReadFrequently: true });
        if (context === null) {
            return undefined;
        }
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
        bitmap.close();
    }
};

// A rendition this engine cannot decode is as final as a refusal: asking again draws the same bytes.
const judge = async (blob: Blob): Promise<ShotLook> => {
    try {
        const pixels = await pixelsOf(blob);
        return pixels === undefined ? UNJUDGED : lookOf(pixels.data, pixels.width, pixels.height);
    } catch {
        return UNJUDGED;
    }
};

const looks = lazyByPath(async (key: string): Promise<ShotLook> => {
    // SAFETY: every key is written by shotLook below, as JSON of exactly this pair.
    const [scope, path] = JSON.parse(key) as [string | null, string];
    let blob: Blob;
    try {
        blob = await renditionBlob(scope ?? undefined, path, `tile`);
    } catch (error) {
        if (error instanceof SandboxHttpError && FINAL.has(error.status)) {
            return UNJUDGED;
        }
        throw error;
    }
    return judge(blob);
});

// A shot's look, starting its read on first ask; undefined while it is on its way. The sandbox's own state is one
// directory every checkout shares, so a shot in it is one entry whatever the scope.
export const shotLook = (scope: string | undefined, path: string): ShotLook | undefined =>
    looks.get(JSON.stringify([path.startsWith(`${STATE_DIR}/`) ? null : (scope ?? null), path]));
