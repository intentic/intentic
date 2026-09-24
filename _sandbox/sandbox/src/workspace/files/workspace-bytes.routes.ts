import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { extractTarToWorkspace, PathEscapeError } from "./workspace-archive.js";
import { computeUploadSkip, type UploadManifestEntry } from "./workspace-diff.js";
import { sha256Text } from "./workspace-files.js";
import { MAX_RAW_BYTES, contentTypeForPath, openWorkspaceFileRange, parseByteRange } from "./workspace-files-download.js";
import { isControlPlanePath, resolveWithin } from "./workspace-files-paths.js";
import { MAX_UPLOAD_BYTES, UploadTooLargeError } from "./workspace-files-upload.js";
import { isRendition, thumbnailable, workspaceThumbnail } from "./workspace-thumbnail.js";
import { insideArchive, scopedTarget } from "../layout/workspace-scope.js";
import { fenceOpens, refuseFenced } from "../layout/workspace-fence.js";
import type { Fence } from "@intentic/sandbox-contract";
import { provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import type { Caller } from "../../auth/auth.js";
import { callerFence } from "../../areas/area-scope.js";

// Byte routes that stay off oRPC because their bodies are streamed: raw file read, ranged media read, and file/diff/tar
// uploads. Registered before the oRPC catch-all, like /health.

export type WorkspaceBytesRoutesDeps = Pick<Services, "workspaceScope" | "files" | "auth" | "mediaTickets" | "workspace" | "history" | "areas" | "agents">;

// Resolves path via scopedTarget and translates its ORPCError into this route's status shape; anything else propagates.
// The same two questions the oRPC reads ask first — whose copy, and whether this caller may look there — since these
// routes carry the bytes and would otherwise be the way around the fence the typed routes apply.
const scopedFileTarget = async (
    services: Pick<Services, "workspaceScope" | "areas" | "agents">,
    path: string,
    agent: string | undefined,
    caller: Caller | undefined,
): Promise<{ target: string } | { error: string; status: 400 | 403 | 404 | 412 }> => {
    try {
        if (agent !== undefined) {
            const entry = services.agents.entry(agent);
            if (entry !== undefined) {
                refuseUnlessVisible(caller, provenanceOf(entry));
            }
        }
        refuseFenced(callerFence(await services.areas.list(), caller), path);
        return { target: (await scopedTarget(services.workspaceScope, agent, path)).target };
    } catch (error) {
        if (!(error instanceof ORPCError)) {
            throw error;
        }
        if (error.code === "BAD_REQUEST") {
            return { error: error.message, status: 400 };
        }
        if (error.code === "FORBIDDEN") {
            return { error: error.message, status: 403 };
        }
        if (error.code === "PRECONDITION_FAILED") {
            return { error: error.message, status: 412 };
        }
        return { error: error.message, status: 404 };
    }
};

// Why an upload can't be written, or undefined when it can: the sandbox's own state is never writable through the
// generic upload, an archive is browsable rather than writable, and nobody writes outside their own folders.
// The attachment exemption `fenceOpens` carries is what keeps a fenced member able to put a file in front of the
// agent they are allowed to talk to, which is the only write their tier has.
const refusedUpload = (
    root: string,
    fence: Fence,
    relPath: string | undefined,
    target: string,
): { error: string; status: 400 | 403 | 404 } | undefined => {
    if (isControlPlanePath(root, target)) {
        return { error: "not found", status: 404 };
    }
    if (insideArchive(root, relPath ?? "")) {
        return { error: "an archive's contents are read-only; extract it to change them", status: 400 };
    }
    if (!fenceOpens(fence, relPath ?? "")) {
        return { error: "outside your access to this workspace", status: 403 };
    }
    return undefined;
};

export const createWorkspaceBytesRoutes = (services: WorkspaceBytesRoutesDeps) => ({
    // GET /workspace/raw: raw bytes for any file under /work, typed by extension; the text route utf8-decodes and would
    // corrupt these. Same guard order as workspace.file: 400/404/413.
    raw: async (c: Context<AppEnv>): Promise<Response> => {
        const path = c.req.query("path");
        if (path === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        // Shared with the oRPC file route so an image previews from the same scope its text reads from.
        const scoped = await scopedFileTarget(services, path, c.req.query("agent"), c.get("identity"));
        if ("error" in scoped) {
            return c.json({ error: scoped.error }, scoped.status);
        }
        const target = scoped.target;
        const file = await services.files.open(target);
        if (file === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        if (file.size > MAX_RAW_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        // Kept and revalidated: a file read again unchanged costs a 304, not its bytes over the tunnel a second time.
        const headers = { "Content-Type": contentTypeForPath(target), ETag: file.tag, "Cache-Control": "private, no-cache" };
        const held = (c.req.header("if-none-match") ?? "").split(",").map((tag) => tag.trim());
        if (held.includes(file.tag)) {
            return c.body(null, 304, headers);
        }
        // Streamed off disk rather than read whole first: the first bytes leave at once, and no copy sits on the heap.
        return c.body(file.body(), 200, { ...headers, "Content-Length": String(file.size) });
    },

    // GET /workspace/thumb: a picture re-encoded for how it is drawn (`size`: tile, strip or view), never the original. The
    // guest asks for one per visible picture, so answering with the file (what /workspace/raw does) moved a gigabyte for a
    // folder of screenshots and seconds per picture on a slow link. Not an error route: a file with nothing to draw
    // answers 404 and the guest keeps the glyph it was already showing.
    thumb: async (c: Context<AppEnv>): Promise<Response> => {
        const path = c.req.query("path");
        if (path === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        const size = c.req.query("size") ?? "tile";
        if (!isRendition(size)) {
            return c.json({ error: "unknown size" }, 400);
        }
        // Shared with the raw route, so a tile and the file it opens are read from the same scope.
        const scoped = await scopedFileTarget(services, path, c.req.query("agent"), c.get("identity"));
        if ("error" in scoped) {
            return c.json({ error: scoped.error }, scoped.status);
        }
        if (!thumbnailable(scoped.target)) {
            return c.json({ error: "not a picture this can draw" }, 415);
        }
        // The reader says what it decodes; a reader that names no AVIF gets WebP, which every engine draws.
        const readsAvif = (c.req.header("accept") ?? "").includes("image/avif");
        const thumbnail = await workspaceThumbnail(services.workspace.root, scoped.target, size, readsAvif);
        if (thumbnail === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        // One URL answers AVIF or WebP by Accept, so a cache must key on it too.
        const vary = { Vary: "Accept" };
        // The tag is the source's own version, so a reload revalidates into a 304 rather than moving the bytes again.
        if (c.req.header("if-none-match") === `"${thumbnail.etag}"`) {
            return c.body(null, 304, { ETag: `"${thumbnail.etag}"`, ...vary });
        }
        return c.body(new Uint8Array(thumbnail.bytes), 200, {
            "Content-Type": thumbnail.type,
            "Content-Length": String(thumbnail.bytes.byteLength),
            ETag: `"${thumbnail.etag}"`,
            // Revalidate rather than reuse blind: the URL names a path, and the file at a path can change.
            "Cache-Control": "private, no-cache",
            ...vary,
        });
    },

    // GET /workspace/media: range-streamed reads for a `<video>`, unlike /workspace/raw's whole-file answer; no byte
    // cap since nothing is buffered.
    // Auth is a query-string ticket (minted via workspace.mediaTicket, bound to one path) since a media element can't
    // send a bearer; loopback has none.
    media: async (c: Context<AppEnv>): Promise<Response> => {
        const path = c.req.query("path");
        if (path === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        const scoped = await scopedFileTarget(services, path, c.req.query("agent"), c.get("identity"));
        if ("error" in scoped) {
            return c.json({ error: scoped.error }, scoped.status);
        }
        const target = scoped.target;
        // Checked against the resolved path, so a ticket for one scope's copy can't be replayed against another's.
        if (services.auth !== undefined && !services.mediaTickets.valid(c.req.query("ticket") ?? "", target)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const size = await services.files.size(target);
        if (size === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        const range = parseByteRange(c.req.header("range"), size);
        if (range === "unsatisfiable") {
            // Must report the real size, or the element retries the same window forever.
            return c.body(null, 416, { "Content-Range": `bytes */${size}` });
        }
        const length = size === 0 ? 0 : range.end - range.start + 1;
        const headers: Record<string, string> = {
            "Content-Type": contentTypeForPath(target),
            "Content-Length": String(length),
            // Without this the element downloads linearly instead of issuing Range requests.
            "Accept-Ranges": "bytes",
            // A cached window of a file rewritten since is corrupt, not stale.
            "Cache-Control": "no-store",
        };
        if (range.partial) {
            headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
        }
        // Cross-origin `download` attributes are ignored; this header drives it instead, filename RFC 5987-encoded.
        if (c.req.query("download") !== undefined) {
            headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`;
        }
        // An empty file has no range to open; createReadStream(start: 0, end: -1) would throw.
        if (length === 0) {
            return c.body(null, 200, headers);
        }
        return c.body(openWorkspaceFileRange(target, range.start, range.end), range.partial ? 206 : 200, headers);
    },

    // POST /workspace/upload: writes one file under /work; drag-drop and the editor's save both post here.
    // Streams straight to disk (parent dirs auto-created); 400 on escape, 413 on oversize.
    upload: async (c: Context<AppEnv>): Promise<Response> => {
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(services.workspace.root, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        const refused = refusedUpload(services.workspace.root, callerFence(await services.areas.list(), c.get("identity")), path, target);
        if (refused !== undefined) {
            return c.json({ error: refused.error }, refused.status);
        }
        // ?offset positions this part of a chunked upload; the write lands in place instead of truncating.
        const offset = Number(c.req.query("offset") ?? 0);
        if (!Number.isInteger(offset) || offset < 0) {
            return c.json({ error: "invalid offset" }, 400);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && offset + declared > MAX_UPLOAD_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        // x-intentic-base-hash pins the sha256 last read by the browser; a mismatch refuses the write with 409.
        const baseHash = c.req.header("x-intentic-base-hash");
        if (baseHash !== undefined) {
            const current = await services.files.read(target);
            if (current === undefined || sha256Text(current) !== baseHash) {
                return c.json({ error: "the file changed on disk since it was read" }, 409);
            }
        }
        const body = c.req.raw.body;
        // An empty body writes only at offset 0; a later empty part must not erase what's already written.
        if (body === null) {
            if (offset === 0) {
                await services.files.write(target, "");
            }
        } else {
            try {
                await services.files.writeStream(target, body, MAX_UPLOAD_BYTES, offset);
            } catch (error) {
                if (error instanceof UploadTooLargeError) {
                    return c.json({ error: "file too large" }, 413);
                }
                throw error;
            }
        }
        // ?mtime is the dropped file's source mtime for upload-diff; editor saves omit it, keeping the write-time
        // mtime.
        const mtime = Number(c.req.query("mtime"));
        if (Number.isFinite(mtime)) {
            await services.files.setMtime(target, mtime);
        }
        services.history.notifyUserWrite();
        return c.json({ ok: true });
    },

    // POST /workspace/upload-diff: given a manifest of path+size+mtime, answers which are already identical on disk
    // (size + whole-second mtime).
    // Live-stats /work including `.git`, no entry cap; read-only, never writes.
    // Answers about paths the caller named, so a fenced one is told only about their own folders: "already on disk"
    // is a fact about a file, and a fenced caller learning it for `finance/payroll.csv` has learnt that it is there.
    uploadDiff: async (c: Context<AppEnv>): Promise<Response> => {
        const { files } = await c.req.json<{ files?: UploadManifestEntry[] }>();
        const fence = callerFence(await services.areas.list(), c.get("identity"));
        const asked = (files ?? []).filter((entry) => fenceOpens(fence, entry.path));
        return c.json({ skip: await computeUploadSkip(services.workspace.root, asked) });
    },

    // POST /workspace/upload-archive: extracts one streamed tar of a dropped tree into /work, entry-by-entry, streamed
    // both ways.
    // Same guards as single upload (400 escape, skip control-plane paths, 413 over cap); `.git` is written, keeping a
    // dropped repo's remote.
    uploadArchive: async (c: Context<AppEnv>): Promise<Response> => {
        const body = c.req.raw.body;
        if (body === null) {
            return c.json({ error: "empty body" }, 400);
        }
        // Refused outright rather than filtered entry by entry: a dropped tree lands where its own paths say, and a
        // half-extracted archive is a worse answer to a fenced caller than a refusal they can act on.
        if (callerFence(await services.areas.list(), c.get("identity")) !== undefined) {
            return c.json({ error: "dropping a whole tree needs access to the whole workspace" }, 403);
        }
        try {
            await extractTarToWorkspace(services.workspace.root, body, MAX_UPLOAD_BYTES);
        } catch (error) {
            if (error instanceof PathEscapeError) {
                return c.json({ error: "invalid path" }, 400);
            }
            if (error instanceof UploadTooLargeError) {
                return c.json({ error: "file too large" }, 413);
            }
            throw error;
        }
        services.history.notifyUserWrite();
        return c.json({ ok: true });
    },
});
