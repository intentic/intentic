import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";

// Serves the Front Desk bundle at /webchat/widget.js, the one <script> a customer's page loads. Served by the daemon,
// not a CDN, so the widget and the routes it talks to always move together; while the sandbox is down, the script
// simply does not load.

// Resolved through the package's own export, so it works the same from src in dev and the pruned image tree.
const widgetPath = (): string => fileURLToPath(import.meta.resolve("@intentic/webchat-widget/widget.js"));

// Read once and kept; a failed read isn't cached, so an unbuilt dev checkout self-heals once built.
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
            // Absent or unbuilt; JS, not a 404, so the site's console says what's wrong.
            c.header("content-type", "application/javascript; charset=utf-8");
            return c.body(`console.error("[intentic] the Front Desk widget bundle is missing from this sandbox image");`, 500);
        }
        // Revalidates every time: the URL is version-less, so long caching would pin visitors to a stale widget.
        c.header("cache-control", "no-cache");
        c.header("etag", bundle.etag);
        if (c.req.header("if-none-match") === bundle.etag) {
            return c.body(null, 304);
        }
        c.header("content-type", "application/javascript; charset=utf-8");
        return c.body(bundle.body);
    };
