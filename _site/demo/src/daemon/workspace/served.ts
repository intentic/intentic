import { zipSync } from "fflate";
import { isPackedName } from "@intentic/sandbox-contract/text/packed-formats";
import { json } from "../../transport";
import { workspaceEntries } from "../../fixture/workspace";
import { bytesOf } from "./bytes";
import { typeOf } from "./rawFile";
import { downloadPlanOf, mediaTicketCovers } from "./tickets";
import { mediaBytes } from "./walkthrough";

// The two byte routes an element loads straight from the daemon's address, answered as the daemon answers them
// (workspace-bytes.routes.ts): GET /workspace/media streams one file in byte ranges, so a <video> seeks and a download
// resumes; GET /workspace/download is a selection as one ZIP, deflating only what compresses.

type Range = { readonly start: number; readonly end: number; readonly partial: boolean } | `unsatisfiable`;

/** The daemon's parseByteRange: one `bytes=` window, open at either end; anything else is the whole file. */
const byteRange = (header: string | null, size: number): Range => {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header?.trim() ?? ``);
    if (match === null || (match[1] === `` && match[2] === ``)) {
        return { start: 0, end: Math.max(0, size - 1), partial: false };
    }
    const [, from = ``, to = ``] = match;
    const start = from === `` ? Math.max(0, size - Number(to)) : Number(from);
    const end = from === `` || to === `` ? size - 1 : Math.min(Number(to), size - 1);
    return start >= size || start > end ? `unsatisfiable` : { start, end, partial: true };
};

/** A file's bytes as an element reads them: whole, or the window its Range header asks for, with what a player needs. */
export const rangedAnswer = (bytes: Uint8Array<ArrayBuffer>, request: Request, headers: Headers): Response => {
    const size = bytes.length;
    const range = byteRange(request.headers.get(`range`), size);
    if (range === `unsatisfiable`) {
        // Must report the real size, or the element retries the same window forever.
        headers.set(`Content-Range`, `bytes */${size}`);
        return new Response(null, { status: 416, headers });
    }
    const body = size === 0 ? new Uint8Array(0) : bytes.slice(range.start, range.end + 1);
    headers.set(`Content-Length`, String(body.length));
    // Without this the element downloads linearly instead of issuing Range requests.
    headers.set(`Accept-Ranges`, `bytes`);
    if (range.partial) {
        headers.set(`Content-Range`, `bytes ${range.start}-${range.end}/${size}`);
    }
    return new Response(body, { status: range.partial ? 206 : 200, headers });
};

const attachment = (name: string): string => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

/** GET /workspace/media: the ticket must name this very file; `download` asks for it as an attachment. */
export const workspaceMedia = async (request: Request, url: URL): Promise<Response> => {
    const path = url.searchParams.get(`path`);
    if (path === null) {
        return json({ error: `invalid path` }, 400);
    }
    if (!mediaTicketCovers(url.searchParams.get(`ticket`) ?? ``, path)) {
        return json({ error: `unauthorized` }, 401);
    }
    const bytes = await mediaBytes(path);
    if (bytes === undefined) {
        return json({ error: `not found` }, 404);
    }
    // A cached window of a file rewritten since is corrupt, not stale.
    const headers = new Headers({ "Content-Type": typeOf(path), "Cache-Control": `no-store` });
    if (url.searchParams.has(`download`)) {
        headers.set(`Content-Disposition`, attachment(path.slice(path.lastIndexOf(`/`) + 1)));
    }
    return rangedAnswer(bytes, request, headers);
};

// Below this a deflate stream's own framing eats what it saves (the daemon's WORTH_DEFLATING).
const WORTH_DEFLATING = 128;

type ZipFiles = Record<string, [Uint8Array, { level: 0 | 6 }]>;

const entry = (name: string, bytes: Uint8Array): ZipFiles[string] => [bytes, { level: bytes.length < WORTH_DEFLATING || isPackedName(name) ? 0 : 6 }];

// One selected path's entries: a file as itself, a folder as every file under it beneath its own name, depth first.
const entriesOf = (path: string, name: string): [string, ZipFiles[string]][] => {
    const own = bytesOf(path);
    if (workspaceEntries().has(path) && own !== undefined) {
        return [[name, entry(name, own)]];
    }
    return [...workspaceEntries().keys()]
        .filter((candidate) => candidate.startsWith(`${path}/`))
        .toSorted()
        .flatMap((file): [string, ZipFiles[string]][] => {
            const inner = `${name}/${file.slice(path.length + 1)}`;
            const bytes = bytesOf(file);
            return bytes === undefined ? [] : [[inner, entry(inner, bytes)]];
        });
};

/** GET /workspace/download: the ticket carries the selection; the archive is written now, from what is there now. */
export const workspaceDownload = (url: URL): Response => {
    const plan = downloadPlanOf(url.searchParams.get(`ticket`) ?? ``);
    if (plan === undefined) {
        return json({ error: `this download link has expired; start the download again` }, 401);
    }
    const files: ZipFiles = Object.fromEntries([...plan.names].flatMap(([path, name]) => entriesOf(path, name)));
    if (Object.keys(files).length === 0) {
        return json({ error: `something selected is not there any more` }, 404);
    }
    const archive = zipSync(files);
    return new Response(archive, {
        status: 200,
        headers: {
            "Content-Type": `application/zip`,
            "Content-Disposition": attachment(plan.filename),
            "Content-Length": String(archive.length),
            "Cache-Control": `no-store`,
        },
    });
};
