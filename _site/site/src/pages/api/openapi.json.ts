import { serializeSpec } from "@intentic/sandbox-openapi";
import type { APIRoute } from "astro";
import { openApiDocument } from "../../lib/api-reference";

// The OpenAPI document, for tooling (client generators, editors, models), not humans. The only copy, generated from the
// contract at build time; nothing else is committed, so there is no drift. Minified: a human reader has the docs pages
// instead.
export const GET: APIRoute = async () =>
    new Response(serializeSpec(await openApiDocument()), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            // Static output, served from the asset layer: this is the hint for anything fetching it directly.
            "cache-control": "public, max-age=3600",
        },
    });
