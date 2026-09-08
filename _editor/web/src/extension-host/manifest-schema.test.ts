import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import {
    CONTRIBUTION_POINTS,
    ExtensionManifestSchema,
    MANIFEST_SCHEMA_URL,
    manifestJsonSchema,
    serializeManifestJsonSchema,
} from "@intentic/extension-manifest";
import { expect, test } from "vitest";

// Generated authoring schema for intentic-extension.json; zod silently strips unknown keys, so without this an editor
// can't catch a misspelt contribution point.
// Two copies are committed (the package, and the site's $schema URL) and checked here against a fresh generation, so
// neither drifts.
// Lives in the web app because the extension-contract conformance tests already run here (surface-guard.test.ts,
// permissions.conformance.test.ts).

const manifestPackage = join(repoRoot(import.meta.url), `_shared/extension-manifest`);

const committedCopies = {
    "the copy that ships inside the package": join(manifestPackage, `intentic-extension.schema.json`),
    "the copy the site serves at the $schema URL": join(repoRoot(import.meta.url), `_site/site/public/intentic-extension.schema.json`),
};

test.each(Object.entries(committedCopies))(`%s matches the contribution points`, (_label, path) => {
    expect(
        readFileSync(path, `utf8`),
        `the manifest's authoring schema moved — run \`pnpm --filter @intentic/extension-manifest schema\` and commit both copies with this change`,
    ).toEqual(serializeManifestJsonSchema(manifestJsonSchema()));
});

test(`the schema's own id is the URL a manifest points at`, () => {
    // Authors copy the $schema line from an existing manifest, so its value must match the served document's $id.
    // A mismatch resolves to a schema claiming to be a different document, which some editors reject.
    const served: { $id?: string } = JSON.parse(readFileSync(committedCopies[`the copy the site serves at the $schema URL`], `utf8`));
    expect(served.$id).toBe(MANIFEST_SCHEMA_URL);
});

test(`every contribution point file is registered`, () => {
    // Adding a point needs a file under points/ plus a line in its index; an uncollected definition is invisible
    // everywhere (schema, generated doc, SDK surface).
    // Points are discovered from the directory, not listed here, so a new one is checked automatically.
    const pointsDir = join(manifestPackage, `src/points`);
    const files = readdirSync(pointsDir).filter((entry) => entry.endsWith(`.ts`) && entry !== `index.ts`);
    const declared = files.map((file) => /name:\s*"([^"]+)"/u.exec(readFileSync(resolve(pointsDir, file), `utf8`))?.[1]);
    expect(declared.filter((name) => name !== undefined).toSorted()).toEqual(CONTRIBUTION_POINTS.map((point) => point.name).toSorted());
});

// Finds every manifest in the repo (first-party extensions and the extension seed template) by walking, not hardcoded
// paths.
// Depth 4 covers the deepest path, _tools/extension-example/seed/.
const repoManifests = (dir = repoRoot(import.meta.url), depth = 4): string[] => {
    if (depth === 0) {
        return [];
    }
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === `intentic-extension.json`) {
            return [join(dir, entry.name)];
        }
        if (!entry.isDirectory() || entry.name.startsWith(`.`) || entry.name === `node_modules` || entry.name === `dist`) {
            return [];
        }
        return repoManifests(join(dir, entry.name), depth - 1);
    });
};

test(`the walk finds the manifests at all`, () => {
    // An empty result would pass the two checks below trivially; assert the walk actually found manifests.
    expect(repoManifests().length).toBeGreaterThan(20);
});

test(`every manifest in the repo points at the published schema`, () => {
    // $schema must be the published URL, not a relative path: manifests get copied (e.g. the seed template) into repos
    // where a relative path resolves to nothing.
    const missing = repoManifests().filter((file) => {
        const manifest: { $schema?: string } = JSON.parse(readFileSync(file, `utf8`));
        return manifest.$schema !== MANIFEST_SCHEMA_URL;
    });
    expect(missing, `add "$schema": "${MANIFEST_SCHEMA_URL}" as the first key`).toEqual([]);
});

test(`no manifest in the repo has a key the schema drops`, () => {
    // zod silently strips keys it doesn't declare, so a misspelt or renamed field parses fine and does nothing.
    // Round-tripping (parse, compare against raw bytes) surfaces anything the schema quietly dropped.
    for (const file of repoManifests()) {
        const raw: unknown = JSON.parse(readFileSync(file, `utf8`));
        expect(ExtensionManifestSchema.parse(raw), `${file} declares something the manifest schema does not`).toEqual(raw);
    }
});

test(`every contribution point explains itself to the author`, () => {
    // description is what an editor shows on hover; that's why a contribution point is an object, not a bare schema.
    // Checked by length, not just presence, since the failure mode is a placeholder, not an empty string.
    for (const point of CONTRIBUTION_POINTS) {
        expect(point.description.length, `contributes.${point.name} needs a description written for the extension author`).toBeGreaterThan(40);
    }
});
