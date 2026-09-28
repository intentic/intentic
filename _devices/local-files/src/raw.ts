import { lutimes, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { json, type RawRoutes } from "@intentic/contract-serve";
import type { LocalFolder, LocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { contentTypeFor, MAX_RAW_BYTES, MAX_WRITE_BYTES, openFile, writeFileWhole, writePartAt, type WriteRefusal } from "./files.js";
import { type Grant, mayWrite } from "./grants.js";
import { cleanRelPath, resolveExisting, resolveWritable } from "./paths.js";

// The routes the daemon serves outside oRPC that a window on a folder uses: the bytes behind the viewers, the one write
// path (the editor's save, a drop into the explorer), and the office extension's own namespace. Each answers in the
// daemon's words for the same case, since the editor reads those.

const REFUSAL_STATUS = {
    changed: { status: 409, error: `the file changed on disk since it was read` },
    busy: { status: 423, error: `another program has the file open` },
    denied: { status: 403, error: `this computer does not let you change that file` },
    "too-large": { status: 413, error: `file too large` },
} as const satisfies Record<WriteRefusal, { readonly status: number; readonly error: string }>;

// Where an upload lands, and the byte it starts at.
interface UploadTarget {
    readonly abs: string;
    readonly offset: number;
}

// The upload's target, or the answer refusing it: a path this window may write, a sane offset, and a declared length
// under the cap. A body that declares none is held to the cap by the write itself (files.ts), which counts what arrives.
const uploadTarget = async (grant: Grant, url: URL, request: Request, cap: number): Promise<UploadTarget | Response> => {
    const path = cleanRelPath(url.searchParams.get(`path`) ?? ``);
    if (path === undefined || path === ``) {
        return json({ error: `invalid path` }, 400);
    }
    if (!mayWrite(grant, path)) {
        return json({ error: `only the file that was opened can be changed from this window` }, 403);
    }
    const resolved = await resolveWritable(grant.root, path);
    if (resolved.kind !== `found`) {
        return json({ error: resolved.kind === `refused` ? resolved.why : `invalid path` }, 400);
    }
    const offset = Number(url.searchParams.get(`offset`) ?? 0);
    if (!Number.isInteger(offset) || offset < 0) {
        return json({ error: `invalid offset` }, 400);
    }
    const declared = Number(request.headers.get(`content-length`) ?? 0);
    if (offset + (Number.isFinite(declared) ? declared : 0) > cap) {
        return json({ error: `file too large` }, 413);
    }
    return { abs: resolved.abs, offset };
};

// Writes the upload where it goes. Its first part (and every save, which is one part) replaces the file whole; a drop's
// later part lands in place rather than truncating the first, as the daemon's does. An empty later part adds nothing.
const writeUpload = async (target: UploadTarget, request: Request, cap: number): Promise<WriteRefusal | undefined> => {
    // The missing folders below the nearest one that exists, which resolveWritable found free of links.
    await mkdir(dirname(target.abs), { recursive: true });
    if (target.offset === 0) {
        return writeFileWhole(target.abs, request.body ?? new Uint8Array(), request.headers.get(`x-intentic-base-hash`) ?? undefined, cap);
    }
    return request.body === null ? undefined : writePartAt(target.abs, request.body, target.offset, cap);
};

// `cap` bounds one upload, MAX_WRITE_BYTES but where a test sets it lower.
export const rawFor = (grant: Grant, office: LocalOffice, folder: LocalFolder, cap = MAX_WRITE_BYTES) =>
    ({
        "GET /workspace/raw": async ({ url, request }) => {
            const resolved = await resolveExisting(grant.root, url.searchParams.get(`path`) ?? ``);
            if (resolved.kind === `refused`) {
                return json({ error: resolved.why }, 400);
            }
            const file = resolved.kind === `found` ? await openFile(resolved.abs) : undefined;
            if (resolved.kind === `missing` || file === undefined) {
                return json({ error: `not found` }, 404);
            }
            if (file.size > MAX_RAW_BYTES) {
                return json({ error: `file too large` }, 413);
            }
            const headers = { "content-type": contentTypeFor(resolved.abs), etag: file.tag, "cache-control": `private, no-cache` };
            const held = (request.headers.get(`if-none-match`) ?? ``).split(`,`).map((tag) => tag.trim());
            if (held.includes(file.tag)) {
                return new Response(null, { status: 304, headers });
            }
            return new Response(file.body(), { headers: { ...headers, "content-length": String(file.size) } });
        },
        "POST /workspace/upload": async ({ url, request }) => {
            const target = await uploadTarget(grant, url, request, cap);
            if (target instanceof Response) {
                return target;
            }
            const refused = await writeUpload(target, request, cap);
            if (refused !== undefined) {
                return json({ error: REFUSAL_STATUS[refused].error }, REFUSAL_STATUS[refused].status);
            }
            const mtime = Number(url.searchParams.get(`mtime`));
            if (Number.isFinite(mtime)) {
                // allow(silent-catch): the time is a hint for the next drop's diff, never worth failing the write over. Set on
                // the entry itself: a link put where the file was since it landed is not followed either.
                await lutimes(target.abs, new Date(mtime), new Date(mtime)).catch(() => undefined);
            }
            return json({ ok: true });
        },
        "ALL /x/*": ({ request }) => office.handle(folder, request),
    }) satisfies RawRoutes;
