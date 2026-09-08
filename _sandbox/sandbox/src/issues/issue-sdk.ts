import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";

// Serves the bug reporter's bundle at /intake/sdk.js, the one <script> a customer's page loads. The daemon serves it
// rather than a CDN so the SDK and its routes move together; a redeployed daemon never fights an SDK built against an
// older wire. While the sandbox is down the script just doesn't load, so the site behaves as if no reporter is
// installed.

// Resolved through the package's own export, working the same from src in dev and the pruned production tree.
const sdkPath = (): string => fileURLToPath(import.meta.resolve("@intentic/issue-sdk/sdk.js"));

// Read once and kept; a read failure isn't cached, so an unbuilt dev checkout self-heals once it's built.
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
            // JS, not 404, so the console names the problem; never throw, since this must not be what breaks the page.
            c.header("content-type", "application/javascript; charset=utf-8");
            return c.body(`console.error("[intentic] the bug reporter bundle is missing from this sandbox image");`, 500);
        }
        // Always revalidates: the URL is version-less, copied once, so a long max-age would pin a stale SDK forever.
        c.header("cache-control", "no-cache");
        c.header("etag", bundle.etag);
        if (c.req.header("if-none-match") === bundle.etag) {
            return c.body(null, 304);
        }
        c.header("content-type", "application/javascript; charset=utf-8");
        return c.body(bundle.body);
    };
