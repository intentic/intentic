#!/usr/bin/env node
// Regenerates the authoring schema from the built dist. Run as `pnpm --filter @intentic/extension-manifest schema`;
// writes both the package copy and the site's public copy, checked against a fresh generation by
// manifest-schema.test.ts.
import { writeFileSync } from "node:fs";
import { manifestJsonSchema, serializeManifestJsonSchema } from "../src/json-schema.js";

const schema = manifestJsonSchema();
const text = serializeManifestJsonSchema(schema);

// Relative to this file: `../` is the package, `../../../` the repo root. The site serves its public/ directory as
// static assets, so a file dropped there is the published URL.
for (const target of ["../intentic-extension.schema.json", "../../../_site/site/public/intentic-extension.schema.json"]) {
    writeFileSync(new URL(target, import.meta.url), text);
}

console.log(`intentic-extension.schema.json: ${Object.keys(schema["properties"]["contributes"]["properties"]).length} contribution points`);
