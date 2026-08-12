#!/usr/bin/env node
/* Regenerate the authoring schema from the built dist — the committed half of the pair json-schema.ts explains.
 * Run as `pnpm --filter @intentic/extension-manifest schema`, which builds first so the schema is always cut
 * from the points as they stand, never from a stale dist.
 *
 * TWO SINKS, ONE GENERATOR. The package copy ships to anyone who installed the SDK and works offline; the site
 * copy answers the `$schema` URL a manifest carries, so an author starting from a bare template gets completion
 * before they have installed anything. Both are written here and both are checked against a fresh generation by
 * manifest-schema.test.ts, so neither can drift from the points or from each other. */
import { writeFileSync } from "node:fs";
import { manifestJsonSchema, serializeManifestJsonSchema } from "../dist/json-schema.js";

const schema = manifestJsonSchema();
const text = serializeManifestJsonSchema(schema);

// Relative to this file: `../` is the package, `../../../` the repo root. The site serves its public/ directory
// as static assets, so a file dropped there IS the published URL.
for (const target of ["../intentic-extension.schema.json", "../../../_site/site/public/intentic-extension.schema.json"]) {
    writeFileSync(new URL(target, import.meta.url), text);
}

console.log(`intentic-extension.schema.json: ${Object.keys(schema["properties"]["contributes"]["properties"]).length} contribution points`);
