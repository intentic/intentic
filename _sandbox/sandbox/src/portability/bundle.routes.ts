import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { ExportBusyError, isReadyExport, listExports, openExport, removeExport, startExport } from "./exports.js";

/* The environment BUNDLE: this sandbox's two volumes packed for a move, and the restore that unpacks one.
 *
 * Raw Hono rather than oRPC for the same reason the upload routes are, a restore and a download are streams
 * of arbitrary size, and neither end may hold one. Owner-only throughout and not merely by convention: an
 * export reads every repo and (at the owner's choice) every credential the sandbox holds, and a restore
 * overwrites the workspace a fleet may be working in.
 *
 * The EXPORT is an artifact, not a response. `POST /bundles` starts the pack and answers with its name at
 * once; the bytes land in the daemon's export directory and `GET /bundles` reads that directory back. This
 * is what makes an export survive the tab that asked for it, see portability/exports.ts for why the first
 * cut, which streamed the pack down the click's own response, could not.
 */

export const createBundleRoutes = (services: Services) => ({
    /** GET /bundles */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ exports: await listExports(services.config.historyRoot) });
    },
    // POST /bundles. Start one. `?secrets=1` is the owner's choice and it changes the BYTES, not the framing,
    // the bundle records what it was made with, and the restore report explains what the choice cost. Default
    // off: the safe bundle is the one you can hand to somebody else.
    start: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        try {
            return c.json({ name: await startExport(services, { secrets: c.req.query("secrets") === "1", now: Date.now() }) });
        } catch (error) {
            if (error instanceof ExportBusyError) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
    },
    /** DELETE /bundles */
    remove: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const removed = await removeExport(services.config.historyRoot, c.req.query("name") ?? "");
        return removed ? c.json({ ok: true }) : c.json({ error: "no such export" }, 404);
    },
    /* POST /bundles/ticket. Mint a ticket for ONE bundle, then serve it at the download route.
     *
     * A download has the same problem a <video> has (see /workspace/media): the browser must fetch it ITSELF for
     * the bytes to stream to disk rather than through the tab's memory, and a navigation cannot carry an
     * Authorization header. The containment is the same too, the ticket names one bundle and buys nothing else.
     * Namespaced `bundle:` so a ticket minted here can never be replayed against a workspace path, nor a media
     * ticket against a bundle.
     */
    ticket: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const name = c.req.query("name") ?? "";
        if (!(await isReadyExport(services.config.historyRoot, name))) {
            return c.json({ error: "no such export" }, 404);
        }
        return c.json(services.mediaTickets.mint(`bundle:${name}`));
    },
    // GET /bundles/download. NAVIGATED to, so the browser's own download manager streams the bytes to disk;
    // exempt from the bearer middleware (app.ts) because a navigation carries no Authorization header, and
    // gated by the ticket minted above instead.
    download: async (c: Context<AppEnv>): Promise<Response> => {
        const name = c.req.query("name") ?? "";
        if (services.auth !== undefined && !services.mediaTickets.valid(c.req.query("ticket") ?? "", `bundle:${name}`)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        // Resolved through the export LIST, so only a finished bundle this daemon produced can be named here,
        // a query string can never walk it onto another file.
        const opened = await openExport(services.config.historyRoot, name);
        if (opened === undefined) {
            return c.json({ error: "no such export" }, 404);
        }
        return c.body(opened.body, 200, {
            "Content-Type": "application/gzip",
            // A real length, unlike the streamed-as-you-pack first cut: the browser can show a progress bar and
            // resume, because the file already exists in full before anyone asks for it.
            "Content-Length": String(opened.size),
            "Content-Disposition": `attachment; filename="${name}"`,
            "Cache-Control": "no-store",
        });
    },
});
