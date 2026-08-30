import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import type { AppEnv } from "../context.js";

/* Serves the bug reporter's bundle at /intake/sdk.js, the one <script> a customer's page loads.
 *
 * The daemon serves it rather than a CDN for the Front Desk widget's reason, which applies here at least as
 * strongly: the SDK and the routes it talks to then move together, a redeployed daemon cannot be handed an SDK
 * built against an older wire, and no cache anywhere holds a version of one that disagrees with the other. The
 * cost is honest and stated in the docs, while the sandbox is down the script does not load, so the site simply
 * has no reporter, which for a crash handler means the page behaves exactly as it did before anyone installed
 * one. */

// Resolved through the package's own export, so it works identically from src in dev and from the pruned
// production tree in the image (where it lands under node_modules/@intentic/issue-sdk/dist).
const sdkPath = (): string => fileURLToPath(import.meta.resolve("@intentic/issue-sdk/sdk.js"));

// Read once and kept: the bundle can only change with the daemon that serves it, so re-reading per request
// would buy nothing. A read failure is not cached, so a dev running from a checkout that hasn't been built yet
// gets a working SDK the moment it is, with no restart.
let cached: { body: string; etag: string } | undefined;

const load = async (): Promise<{ body: string; etag: string }> => {
    if (cached !== undefined) {
        return cached;
    }
    const body = await readFile(sdkPath(), "utf8");
    cached = { body, etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"` };
    return cached;
};

export const createSdkRoute =
    () =>
    async (c: Context<AppEnv, "/intake/sdk.js">): Promise<Response> => {
        let bundle: { body: string; etag: string };
        try {
            bundle = await load();
        } catch {
            /* The package is absent or unbuilt. JS rather than a 404 so the site's console says what is wrong
             * instead of only that a script failed to load, and a console.error rather than a throw because
             * this script's whole job is to not be the thing that breaks the page. */
            c.header("content-type", "application/javascript; charset=utf-8");
            return c.body(`console.error("[intentic] the bug reporter bundle is missing from this sandbox image");`, 500);
        }
        // Revalidate every time, serve from the browser's cache when unchanged: the URL is version-less (it must
        // be, the embed snippet is copied once and lives on the customer's page forever), so a long max-age
        // would pin visitors to a stale SDK across a daemon upgrade.
        c.header("cache-control", "no-cache");
        c.header("etag", bundle.etag);
        if (c.req.header("if-none-match") === bundle.etag) {
            return c.body(null, 304);
        }
        c.header("content-type", "application/javascript; charset=utf-8");
        return c.body(bundle.body);
    };
