import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { ExportBusyError, isReadyExport, listExports, openExport, removeExport, startExport } from "./exports.js";

// Environment bundle: this sandbox's two volumes packed for a move, and the restore that unpacks one. Raw Hono handles
// the arbitrary-size streams on both ends; owner-only, since export reads every credential and restore overwrites the
// workspace. An export is an artifact, not a response: it lands in a directory and survives the tab that asked for it.

export const createBundleRoutes = (services: Services) => ({
    /** GET /bundles */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ exports: await listExports(services.config.historyRoot) });
    },
    // `?secrets=1` changes the bytes, not the framing; the bundle records what it was made with and the restore report
    // explains the cost. Default off, so the safe bundle is the one you can hand to somebody else.
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
    // Mints a ticket for one bundle, since a navigated download carries no Authorization header (same problem as
    // workspace media). Namespaced `bundle:` so it can't be replayed against another kind of ticket.
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
    // Navigated to, so the browser's own download manager streams to disk; exempt from the bearer middleware since
    // navigation carries no Authorization header, gated by the ticket instead.
    download: async (c: Context<AppEnv>): Promise<Response> => {
        const name = c.req.query("name") ?? "";
        if (services.auth !== undefined && !services.mediaTickets.valid(c.req.query("ticket") ?? "", `bundle:${name}`)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        // Resolved through the export list, so only a finished bundle this daemon produced can be named here.
        const opened = await openExport(services.config.historyRoot, name);
        if (opened === undefined) {
            return c.json({ error: "no such export" }, 404);
        }
        return c.body(opened.body, 200, {
            "Content-Type": "application/gzip",
            // Real length: the file exists in full before download, so the browser can show progress and resume.
            "Content-Length": String(opened.size),
            "Content-Disposition": `attachment; filename="${name}"`,
            "Cache-Control": "no-store",
        });
    },
});
