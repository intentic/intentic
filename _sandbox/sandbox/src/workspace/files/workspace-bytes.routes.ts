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
import { scopedTarget } from "../layout/workspace-scope.js";

// Byte routes that stay off oRPC because their bodies are streamed: raw file read, ranged media read, and file/diff/tar
// uploads. Registered before the oRPC catch-all, like /health.

export type WorkspaceBytesRoutesDeps = Pick<Services, "workspaceScope" | "files" | "auth" | "mediaTickets" | "workspace" | "history">;

// Resolves path via scopedTarget and translates its ORPCError into this route's status shape; anything else propagates.
const scopedFileTarget = async (
    services: Pick<Services, "workspaceScope">,
    path: string,
    agent: string | undefined,
): Promise<{ target: string } | { error: string; status: 400 | 404 | 412 }> => {
    try {
        return { target: (await scopedTarget(services.workspaceScope, agent, path)).target };
    } catch (error) {
        if (!(error instanceof ORPCError)) {
            throw error;
        }
        if (error.code === "BAD_REQUEST") {
            return { error: error.message, status: 400 };
        }
        if (error.code === "PRECONDITION_FAILED") {
            return { error: error.message, status: 412 };
        }
        return { error: error.message, status: 404 };
    }
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
        const scoped = await scopedFileTarget(services, path, c.req.query("agent"));
        if ("error" in scoped) {
            return c.json({ error: scoped.error }, scoped.status);
        }
        const target = scoped.target;
        const size = await services.files.size(target);
        if (size === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        if (size > MAX_RAW_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        const bytes = await services.files.readBytes(target);
        if (bytes === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        // Buffer's backing is ArrayBufferLike, which Hono's body type rejects; copy is cheap under MAX_RAW_BYTES.
        return c.body(new Uint8Array(bytes), 200, { "Content-Type": contentTypeForPath(target), "Content-Length": String(bytes.byteLength) });
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
        const scoped = await scopedFileTarget(services, path, c.req.query("agent"));
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
        // Sandbox's private state isn't writable through the generic upload.
        if (isControlPlanePath(services.workspace.root, target)) {
            return c.json({ error: "not found" }, 404);
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
    uploadDiff: async (c: Context<AppEnv>): Promise<Response> => {
        const { files } = await c.req.json<{ files?: UploadManifestEntry[] }>();
        return c.json({ skip: await computeUploadSkip(services.workspace.root, files ?? []) });
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
