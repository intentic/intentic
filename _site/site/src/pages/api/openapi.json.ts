import { serializeSpec } from "@intentic/sandbox-openapi";
import type { APIRoute } from "astro";
import { openApiDocument } from "../../lib/api-reference";

/* THE DOCUMENT ITSELF, for a reader whose next move is to point their own tooling at it rather than to read
 * anything: a client generator, an editor's HTTP plugin, a model given a tool description.
 *
 * IT IS NOT COMMITTED ANYWHERE. This route is the only copy, made from the contract at build time, so there is
 * no drift to test for: there is one document and it is generated from the code every time. See spec.ts in
 * @intentic/sandbox-openapi for why that is the opposite call to the one contract-lock.ts makes next door.
 *
 * Minified, because the only readers are machines. Somebody who wants to READ it has the 37 pages beside this
 * route, which is the whole point of having built them. */
export const GET: APIRoute = async () =>
    new Response(serializeSpec(await openApiDocument()), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            // Static output, served from the asset layer: this is the hint for anything fetching it directly.
            "cache-control": "public, max-age=3600",
        },
    });
