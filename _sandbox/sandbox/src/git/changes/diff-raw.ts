import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { contentTypeForPath } from "../../workspace/files/workspace-files-download.js";
import { createDiffLocator, DiffLocateError, parseDiffSourceQuery } from "./diff-locate.js";

// Bytes behind a binary diff (JSON diff can't carry them); sibling of /workspace/raw. Covers all four diff sources
// (working/agent/commit/checkpoint) through diff-locate.ts, each resolving the same rev-specs as its JSON counterpart.

// A checkout refusal from the shared view resolver (git-view.ts) is oRPC's; a raw route answers it with the same status
// the typed /diff/derived twin would, rather than a bare 500 that hides why.
const ORPC_STATUS = new Map<string, 400 | 403 | 404 | 412>([
    ["BAD_REQUEST", 400],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["PRECONDITION_FAILED", 412],
]);

export const createDiffRawRoute = (services: Services) => {
    const locator = createDiffLocator(services);

    return async (c: Context<AppEnv>): Promise<Response> => {
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
            const status = error instanceof ORPCError ? ORPC_STATUS.get(error.code) : undefined;
            if (status !== undefined && error instanceof Error) {
                return c.json({ error: error.message }, status);
            }
            // Raw routes sit outside oRPC's logging interceptor (app.ts), so a fault here was a 500 nothing recorded.
            services.logger.error({ err: error, query: Object.fromEntries(query) }, "diff/raw: a side could not be served");
            throw error;
        }
    };
};
