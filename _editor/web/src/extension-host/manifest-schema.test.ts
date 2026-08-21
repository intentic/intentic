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

/* THE AUTHORING SCHEMA, AND THE REGISTRY IT COMES OUT OF.
 *
 * `intentic-extension.json` is written by hand, and until it had a schema it was written by copying another
 * extension's and guessing: zod strips unknown keys at every level rather than refusing them, so a misspelt
 * contribution point was not an error: it was a view that never appeared, found at install, with the manifest
 * parsing perfectly. The generated schema is what makes an editor say so while the author is typing.
 *
 * It is committed rather than built on demand for the reason contract.lock.json is: a generated document only
 * guards anything if a diff shows it moving. Two copies are committed: the one that ships inside the package,
 * and the one the site serves at the `$schema` URL, and both are checked here against a fresh generation, so
 * neither can drift from the points or from each other.
 *
 * These live in the web app rather than beside the SDK because this is where the extension-contract conformance
 * tests already run (surface-guard.test.ts, permissions.conformance.test.ts): the manifest package ships no
 * test harness, and giving it one to hold two checks would be the more expensive half of this. */

const manifestPackage = join(repoRoot(import.meta.url), `_sandbox/extension-manifest`);

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
    // An author copies the `$schema` line out of an existing manifest, so the value in those files and the `$id`
    // the served document answers with have to be the same string: a mismatch is a schema that resolves to
    // something claiming to be a different document, which some editors reject outright.
    const served: { $id?: string } = JSON.parse(readFileSync(committedCopies[`the copy the site serves at the $schema URL`], `utf8`));
    expect(served.$id).toBe(MANIFEST_SCHEMA_URL);
});

test(`every contribution point file is registered`, () => {
    /* Adding a point is a file under points/ plus a line in its index, and this is what stops the pair coming
     * apart. A definition nothing collects is invisible everywhere at once: not in the manifest schema, not in
     * the generated document, not in the SDK's recorded surface. It would look exactly like a point that works
     * until someone tried to declare it.
     *
     * Discovered from the directory rather than listed here, so a point added tomorrow is checked tomorrow. */
    const pointsDir = join(manifestPackage, `src/points`);
    const files = readdirSync(pointsDir).filter((entry) => entry.endsWith(`.ts`) && entry !== `index.ts`);
    const declared = files.map((file) => /name:\s*"([^"]+)"/u.exec(readFileSync(resolve(pointsDir, file), `utf8`))?.[1]);
    expect(declared.filter((name) => name !== undefined).toSorted()).toEqual(CONTRIBUTION_POINTS.map((point) => point.name).toSorted());
});

/* Every manifest in this repository, found rather than listed: the first-party extensions and the seed a new
 * one is copied from, which live in two different areas and would otherwise be two hardcoded paths that miss
 * the third one somebody adds.
 *
 * A shallow walk rather than `git ls-files`: shelling out to git would make this a suite that reaches for the
 * machine, and the naming rule that comes with it, for an answer a few readdirs already have. Depth 4 clears
 * the deepest of them (_tools/extension-example/seed/) with room to spare. */
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
    // A discovery test that silently matches nothing asserts nothing, and the two tests below are both "none of
    // them is wrong", which an empty list passes.
    expect(repoManifests().length).toBeGreaterThan(20);
});

test(`every manifest in the repo points at the published schema`, () => {
    /* The `$schema` line is what turns editing one of these from guesswork into completion and hover text, and
     * the seed manifest is the file a new extension is copied from, so an author who starts the documented way
     * gets it without being told.
     *
     * It has to be the published URL rather than a path into this checkout, precisely BECAUSE these get copied:
     * a relative path that resolves here resolves to nothing in the repository someone pastes it into. */
    const missing = repoManifests().filter((file) => {
        const manifest: { $schema?: string } = JSON.parse(readFileSync(file, `utf8`));
        return manifest.$schema !== MANIFEST_SCHEMA_URL;
    });
    expect(missing, `add "$schema": "${MANIFEST_SCHEMA_URL}" as the first key`).toEqual([]);
});

test(`no manifest in the repo has a key the schema drops`, () => {
    /* THE SILENT DROP, CAUGHT. zod strips what it does not declare at every level rather than refusing it, so a
     * misspelt `viewers`, or a field that was renamed a release ago, parses perfectly and simply does nothing:
     * the author finds out when the thing they declared never appears.
     *
     * Round-tripping is what makes that visible without a JSON Schema validator in the test: parse, and compare
     * against the bytes. Anything the schema quietly removed shows up as a difference. The generated schema
     * refuses the same keys outright in the author's editor; this is the same guarantee for the manifests that
     * ship here. */
    for (const file of repoManifests()) {
        const raw: unknown = JSON.parse(readFileSync(file, `utf8`));
        expect(ExtensionManifestSchema.parse(raw), `${file} declares something the manifest schema does not`).toEqual(raw);
    }
});

test(`every contribution point explains itself to the author`, () => {
    /* The description is the whole reason a point is an object rather than a bare schema: it is what an editor
     * shows on hover, and before it existed the explanation of every point sat in a comment the author could
     * never see. An empty one is a point that silently goes back to being undocumented.
     *
     * Length rather than mere presence, because the failure mode is a placeholder, not an omission. */
    for (const point of CONTRIBUTION_POINTS) {
        expect(point.description.length, `contributes.${point.name} needs a description written for the extension author`).toBeGreaterThan(40);
    }
});
