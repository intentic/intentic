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

/* The workspace's BYTE routes, the reads and writes that stay off oRPC because their bodies are streamed bytes
 * rather than JSON: the raw file read the browser previews images/PDF from, the ranged media read a <video>
 * talks to, and the three upload doors (one file, a re-upload manifest diff, a whole dropped tree as a tar).
 * Registered in app.ts before the oRPC catch-all, like /health. */

export type WorkspaceBytesRoutesDeps = Pick<Services, "workspaceScope" | "files" | "auth" | "mediaTickets" | "workspace" | "history">;

/* The scoped read, in the shape these byte routes can answer in. `scopedTarget` is the one resolver
 * (workspace/workspace-scope.ts) and it signals through ORPCError, because every other caller is an oRPC
 * handler; here the throw is translated once rather than at each call site, and an unexpected error still
 * propagates as an error rather than being flattened into a 404. */
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
    // GET /workspace/raw. Raw bytes for any file under /work, with a Content-Type by extension, the browser
    // previews images/PDF here (the text route utf8-decodes and would corrupt them). Same guards/order as
    // workspace.file: 400 on escape, 404 on missing, 413 on oversize.
    raw: async (c: Context<AppEnv>): Promise<Response> => {
        const path = c.req.query("path");
        if (path === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        // Whose copy, and the escape + control-plane guards with it (scopedTarget → containedIn). Shared with
        // the oRPC file route so an image in a conversation's checkout previews from the same tree its text
        // reads from; the guards throw ORPCError, which these byte routes translate to their own JSON shape.
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
        // Wrap in a fresh Uint8Array so the body type is exactly Uint8Array<ArrayBuffer> (a Buffer's backing is
        // ArrayBufferLike, which Hono's body type rejects); bounded by MAX_RAW_BYTES, so the copy is cheap.
        return c.body(new Uint8Array(bytes), 200, { "Content-Type": contentTypeForPath(target), "Content-Length": String(bytes.byteLength) });
    },

    /* GET /workspace/media. THE ROUTE A <video> TALKS TO ITSELF: /workspace/raw's sibling for timed media, and
     * separate from it because a media element is not a caller that wants a Blob.
     *
     * /workspace/raw answers one whole file into memory, and its 25 MiB ceiling exists precisely because it
     * does. Under that contract a recording is either refused outright or must download in full before its
     * first frame paints, and a seek to 40:00 can only wait for the 39 minutes in front of it. None of that is
     * a size problem: it is the shape of the answer. So this route answers a RANGE, streamed off disk, the
     * element asks for the header, then the index, then whatever window the user just dragged to, and each one
     * costs a seek and a 64 KiB chunk instead of the file. There is no byte cap here for the same reason: what
     * MAX_RAW_BYTES protects is the daemon's heap, and nothing is ever held.
     *
     * The credential is the other difference. Every other route on this daemon takes a bearer, and a media
     * element cannot send one, so this one takes a ticket from the query string, minted over the ordinary
     * authenticated contract (workspace.mediaTicket) and bound to a single path. See auth/media-tickets.ts for
     * why that binding is what makes a longer-lived, replayable credential an acceptable trade here.
     *
     * Loopback mode has no `auth` and therefore no ticket to check, exactly like the WebSocket upgrades. */
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
        // The ticket is checked against the RESOLVED file, which is what makes the binding hold under a scope:
        // one minted for a conversation's copy of `demo.mp4` cannot be replayed for the shared tree's.
        if (services.auth !== undefined && !services.mediaTickets.valid(c.req.query("ticket") ?? "", target)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const size = await services.files.size(target);
        if (size === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        const range = parseByteRange(c.req.header("range"), size);
        if (range === "unsatisfiable") {
            // 416 must state the real size, or the element retries the same doomed window forever.
            return c.body(null, 416, { "Content-Range": `bytes */${size}` });
        }
        const length = size === 0 ? 0 : range.end - range.start + 1;
        const headers: Record<string, string> = {
            "Content-Type": contentTypeForPath(target),
            "Content-Length": String(length),
            // Without this the element never issues a Range at all, it downloads linearly and the scrubber
            // can only reach what has already arrived.
            "Accept-Ranges": "bytes",
            // The agent rewrites files under the reader's feet; a cached window of a file that has since
            // changed is a corrupt stream, not a stale one.
            "Cache-Control": "no-store",
        };
        if (range.partial) {
            headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
        }
        /* SAVE THIS RATHER THAN PLAY IT. The browser's own `download` attribute is no use here, the daemon is
         * a different origin, where it is ignored and the link merely navigates, so the intent has to come
         * from the server. Which also makes this the download path for a file /workspace/raw would refuse:
         * nothing is buffered, so size stops mattering. RFC 5987 encoding, because a workspace filename is
         * whatever the user called it. */
        if (c.req.query("download") !== undefined) {
            headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`;
        }
        // An empty file has no range to open, createReadStream(start: 0, end: -1) would throw.
        if (length === 0) {
            return c.body(null, 200, headers);
        }
        return c.body(openWorkspaceFileRange(target, range.start, range.end), range.partial ? 206 : 200, headers);
    },

    // POST /workspace/upload. Write one file under /work, the drag-drop upload AND the editor's text save both
    // post here (bytes / utf8 body are the same to persist), so writes stay off oRPC like the raw read above.
    // The body streams straight to disk (no full-buffer), so multi-GB uploads stay flat in memory; parent dirs
    // are auto-created, so a nested dropped-folder path materializes its tree. Guards: 400 on escape, 413 on
    // oversize (Content-Length first, then the running byte count as it streams).
    upload: async (c: Context<AppEnv>): Promise<Response> => {
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(services.workspace.root, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        // Same floor as the raw read: the sandbox's private state is not writable through the generic upload,
        // or any member could hand themselves the sandbox by posting a new owner.json.
        if (isControlPlanePath(services.workspace.root, target)) {
            return c.json({ error: "not found" }, 404);
        }
        // A big file arrives as sequential parts (the browser keeps each request under Cloudflare's ~100 MB edge
        // body cap); ?offset says where this part lands, and the write goes in place instead of truncating.
        const offset = Number(c.req.query("offset") ?? 0);
        if (!Number.isInteger(offset) || offset < 0) {
            return c.json({ error: "invalid offset" }, 400);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && offset + declared > MAX_UPLOAD_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        // The editor's guarded save: `x-intentic-base-hash` carries the sha256 of the text the browser last knew
        // on disk (its baseline), and the write is refused when the file no longer matches, an agent or terminal
        // write landed since that read, and a blind overwrite would clobber it. 409 keeps the file untouched; the
        // browser shows its changed-on-disk banner with the user's edits preserved. Drag-drop uploads send no
        // hash and overwrite as before. Check-then-write, not atomic, the guard shrinks the race window from
        // the whole edit session to this handler, which is what the agent needs (its writes echo over the SSE in
        // ~250ms; the guard covers exactly that gap).
        const baseHash = c.req.header("x-intentic-base-hash");
        if (baseHash !== undefined) {
            const current = await services.files.read(target);
            if (current === undefined || sha256Text(current) !== baseHash) {
                return c.json({ error: "the file changed on disk since it was read" }, 409);
            }
        }
        const body = c.req.raw.body;
        // An empty body (a new empty file, or saving an emptied editor buffer) has no stream to pipe. Only at
        // offset 0, an empty later part must not wipe the parts already written.
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
        // A dropped file passes its source mtime as ?mtime so a re-upload can skip it (upload-diff); the editor's
        // text save sends none and keeps the write-time mtime.
        const mtime = Number(c.req.query("mtime"));
        if (Number.isFinite(mtime)) {
            await services.files.setMtime(target, mtime);
        }
        services.history.notifyUserWrite();
        return c.json({ ok: true });
    },

    // POST /workspace/upload-diff. Re-upload diff: the client posts a manifest of what it's about to upload
    // (path + source size + mtime) and we answer which paths are already identical on disk (same size +
    // whole-second mtime), so the browser drops those and re-sends only what changed. Live-stats /work (unlike
    // the filtered tree, this sees `.git` and has no entry cap). Read-only, never writes; escaping/denied paths
    // simply aren't reported as skippable.
    uploadDiff: async (c: Context<AppEnv>): Promise<Response> => {
        const { files } = await c.req.json<{ files?: UploadManifestEntry[] }>();
        return c.json({ skip: await computeUploadSkip(services.workspace.root, files ?? []) });
    },

    // POST /workspace/upload-archive. Bulk directory upload: the browser streams ONE tar of a large dropped
    // tree here (over per-file POSTs, which cost a round-trip each) and we extract it entry-by-entry into
    // /work. Same guards as the single upload, applied per entry: 400 on any escaping path (aborts), silently
    // skips the daemon's control-plane files (isControlPlanePath), 413 once the running total passes the cap.
    // `.git` IS written, a dropped repo keeps its own, so it stays connected to its remote. Streamed both
    // ways, so a huge tree never lands in memory.
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
