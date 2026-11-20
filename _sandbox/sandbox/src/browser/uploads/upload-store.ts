import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { nodeStream } from "@intentic/base/web-stream";
import { isUnder } from "../../workspace/files/workspace-files-paths.js";
import { UploadTooLargeError, writeStreamCounted } from "../../workspace/files/workspace-files-upload.js";
import { safeFileName } from "../downloads/download-files.js";

// Files the person sent up for a page: picked for its file chooser (file-chooser.ts) or dropped on it (drop.ts). They
// land in a temp folder of their own, one folder per upload, never the workspace and never the browser's profile, and
// the page is handed their paths. Chromium reads a picked file lazily, when the page uploads or reads it, so a file
// stays a day after it arrived; every upload is capped, and so is the folder as a whole.

const UPLOAD_ROOT = join(tmpdir(), "intentic-browser-uploads");

export interface UploadLimits {
    // One file, whatever its parts add up to.
    readonly fileBytes: number;
    // Everything the folder holds at once.
    readonly totalBytes: number;
    // How long an upload is kept after it arrived.
    readonly keepMs: number;
}

// 2 GiB a file covers a video a person would put in a form; 8 GiB at once bounds what a forgotten afternoon of uploads
// can take of /tmp. A day is longer than any form is left half-filled.
const UPLOAD_LIMITS: UploadLimits = { fileBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, keepMs: 24 * 3_600_000 };

const ID = /^[A-Za-z0-9_-]{8,64}$/u;

export class UploadRefused extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 413 | 507,
    ) {
        super(message);
    }
}

// The one place an upload can be: `<root>/<id>/<name>`, the id the uploader's own (validated, one path segment) and the
// name made safe the way a download's is. Checked against the root once joined, so nothing either side sends can put a
// file anywhere else.
export const uploadPath = (root: string, id: string, name: string): string => {
    if (!ID.test(id)) {
        throw new UploadRefused("an upload id is 8 to 64 letters, digits, - or _", 400);
    }
    const path = join(root, id, safeFileName(name));
    if (isUnder(root, path) === undefined || !path.startsWith(`${join(root, id)}/`)) {
        throw new UploadRefused("invalid upload name", 400);
    }
    return path;
};

// How many bytes the folder holds now, every upload's file summed.
const folderBytes = async (root: string): Promise<number> => {
    let total = 0;
    // allow(silent-catch): no folder yet holds nothing.
    for (const id of await readdir(root).catch((): string[] => [])) {
        // allow(silent-catch): an upload swept between the two reads holds nothing.
        for (const name of await readdir(join(root, id)).catch((): string[] => [])) {
            // allow(silent-catch): as above.
            total += (await stat(join(root, id, name)).catch(() => undefined))?.size ?? 0;
        }
    }
    return total;
};

// allow(silent-catch): a path that cannot be read holds no first part, which is the refusal it leads to.
const onDisk = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;

/**
 * Writes one part of an upload at `offset` (the first part makes the file); refuses past the file's cap or the
 * folder's. Answers where the file is.
 */
export const writeUploadPart = async (
    input: { readonly id: string; readonly name: string; readonly offset: number; readonly body: ReadableStream<Uint8Array> | null },
    root = UPLOAD_ROOT,
    limits: UploadLimits = UPLOAD_LIMITS,
): Promise<string> => {
    const path = uploadPath(root, input.id, input.name);
    if (!Number.isInteger(input.offset) || input.offset < 0) {
        throw new UploadRefused("invalid offset", 400);
    }
    if (input.offset >= limits.fileBytes) {
        throw new UploadRefused("file too large", 413);
    }
    if (input.offset === 0) {
        await sweepUploads(Date.now(), root, limits);
        if ((await folderBytes(root)) >= limits.totalBytes) {
            throw new UploadRefused("the browser's upload space is full; try again once earlier uploads are cleared", 507);
        }
        // A fresh first part starts the upload over: whatever an earlier attempt under this id left goes.
        await rm(join(root, input.id), { recursive: true, force: true });
        await mkdir(join(root, input.id), { recursive: true });
    } else if (!(await onDisk(path))) {
        throw new UploadRefused("a later part arrived for an upload that has no first part", 404);
    }
    const source = input.body === null ? Readable.from([]) : Readable.fromWeb(nodeStream(input.body));
    try {
        await writeStreamCounted(source, path, () => limits.fileBytes - input.offset, input.offset);
    } catch (error) {
        if (error instanceof UploadTooLargeError) {
            await rm(join(root, input.id), { recursive: true, force: true });
            throw new UploadRefused("file too large", 413);
        }
        throw error;
    }
    return path;
};

/** The files uploaded under these ids, in order; refuses an id with no file, since the page would get less than was picked. */
export const uploadedFiles = async (ids: readonly string[], root = UPLOAD_ROOT): Promise<string[]> => {
    const files: string[] = [];
    for (const id of ids) {
        if (!ID.test(id)) {
            throw new UploadRefused(`no upload ${id}`, 404);
        }
        // allow(silent-catch): an upload that is not there is the refusal below.
        const [name] = await readdir(join(root, id)).catch((): string[] => []);
        if (name === undefined) {
            throw new UploadRefused(`no upload ${id}`, 404);
        }
        files.push(uploadPath(root, id, name));
    }
    return files;
};

/** Removes every upload older than the limits keep. */
export const sweepUploads = async (now: number, root = UPLOAD_ROOT, limits: UploadLimits = UPLOAD_LIMITS): Promise<void> => {
    // allow(silent-catch): no folder yet has nothing to sweep.
    for (const id of await readdir(root).catch((): string[] => [])) {
        const folder = join(root, id);
        // allow(silent-catch): an upload removed meanwhile is swept already.
        const info = await stat(folder).catch(() => undefined);
        if (info !== undefined && now - info.mtimeMs > limits.keepMs) {
            await rm(folder, { recursive: true, force: true });
        }
    }
};
