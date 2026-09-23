import { Hono } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { rawRouteServer } from "../../raw-route-server.js";
import { contentTypeForPath } from "../../workspace/files/workspace-files-download.js";
import { createDiffLocator, DiffLocateError, parseDiffSourceQuery } from "./diff-locate.js";

// Bytes behind a binary diff (JSON diff can't carry them); sibling of /workspace/raw. Covers all four diff sources
// (working/agent/commit/checkpoint) through diff-locate.ts, each resolving the same rev-specs as its JSON counterpart.

export const createDiffRawRoute = (services: Services): Hono<AppEnv> => {
    const locator = createDiffLocator(services);
    const app = new Hono<AppEnv>();

    rawRouteServer(app)("GET /diff/raw", async (c) => {
        const query = new URL(c.req.url).searchParams;
        try {
            const which = query.get("which");
            if (which !== "before" && which !== "after") {
                throw new DiffLocateError(400, "which must be before or after");
            }
            const source = parseDiffSourceQuery(query);
            const located = await locator.locate(source, which);
            if (located === undefined) {
                throw new DiffLocateError(404, "not found");
            }
            const bytes = await locator.read(located);

            // Copied into a fresh Uint8Array: Hono rejects a Buffer's ArrayBufferLike backing.
            return c.body(new Uint8Array(bytes), 200, {
                "Content-Type": contentTypeForPath(source.path),
                "Content-Length": String(bytes.byteLength),
            });
        } catch (error) {
            if (error instanceof DiffLocateError) {
                return c.json({ error: error.message }, error.status);
            }
            throw error;
        }
    });

    return app;
};
