import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import type { AppEnv } from "../context.js";

/* Serves the Front Desk bundle at /webchat/widget.js — the one <script> a customer's page loads.
 *
 * The daemon serves it rather than a CDN because the widget and the routes it talks to then move together: a
 * daemon that has been redeployed cannot be handed a widget built against an older wire, and there is no cache
 * anywhere holding a version of one that disagrees with the other. The cost is honest and stated in the docs —
 * while the sandbox is down the script does not load, so the site simply has no launcher. */

// Resolved through the package's own export, so it works identically from src in dev and from the pruned
// production tree in the image (where it lands under node_modules/@intentic/webchat-widget/dist).
const widgetPath = (): string => fileURLToPath(import.meta.resolve("@intentic/webchat-widget/widget.js"));

// Read once and kept: the bundle is ~18 KB and can only change with the daemon that serves it, so re-reading
// per request would buy nothing. A read failure is not cached — a dev running from a checkout that hasn't been
// built yet gets a working widget the moment it is, with no restart.
let cached: { body: string; etag: string } | undefined;

const load = async (): Promise<{ body: string; etag: string }> => {
    if (cached !== undefined) {
        return cached;
    }
    const body = await readFile(widgetPath(), "utf8");
    cached = { body, etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"` };
    return cached;
};

export const createWidgetRoute =
    () =>
    async (c: Context<AppEnv, "/webchat/widget.js">): Promise<Response> => {
        let bundle: { body: string; etag: string };
        try {
            bundle = await load();
        } catch {
            // The package is absent or unbuilt. JS rather than a 404 so the site's console says what is wrong
            // instead of only that a script failed to load.
            c.header("content-type", "application/javascript; charset=utf-8");
            return c.body(`console.error("[intentic] the Front Desk widget bundle is missing from this sandbox image");`, 500);
        }
        // Revalidate every time, serve from the browser's cache when unchanged: the URL is version-less (it must
        // be — the embed snippet is copied once and lives on the customer's page forever), so a long max-age
        // would pin visitors to a stale widget across a daemon upgrade.
        c.header("cache-control", "no-cache");
        c.header("etag", bundle.etag);
        if (c.req.header("if-none-match") === bundle.etag) {
            return c.body(null, 304);
        }
        c.header("content-type", "application/javascript; charset=utf-8");
        return c.body(bundle.body);
    };
