import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionApiVersion } from "@intentic/extension-api";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { expect, test } from "vitest";

/* THE SDK'S SURFACE, BOUND TO THE VERSION IT PROMISES.
 *
 * `engines.intentic` is an author's only way to say which host they need, and it is worth exactly as much as
 * extensionApiVersion is true. Twice it wasn't: `contributes.connectors` became `contributes.capabilities` and
 * `api.documents.open` was added, both without a bump — so a manifest written against the published SDK named a
 * contribution point the host had renamed, and the schema DROPPED it silently (unknown keys are not an error).
 * An author got no view, no warning, and a version number that said they were compatible.
 *
 * So the surface is recorded here per version, and this fails when the live one stops matching. Changing the
 * surface then costs a new entry in surface.json — which is the bump, made unavoidable rather than remembered.
 * Editing an existing entry instead would also pass; that is deliberate and sufficient, because it turns a
 * silent omission into a diff that visibly rewrites history, which review catches.
 *
 * It lives in the web app rather than beside the SDK because this is where the extension-contract conformance
 * tests already run (permissions.conformance.test.ts, engines.test.ts) — extension-api itself ships no test
 * harness, and giving it one to hold a single snapshot would be the more expensive half of this.
 *
 * The grain is TOP-LEVEL KEYS on purpose. That is precisely where a mismatch is silent: an unknown key inside a
 * contribution entry fails the parse loudly and the author sees it, an unknown key at the top is dropped. */

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), `../../../../_sandbox/extension-api`);

interface RecordedSurface {
    readonly manifest: readonly string[];
    readonly contributes: readonly string[];
    readonly api: readonly string[];
    readonly listener?: readonly string[];
}

const recorded: Record<string, RecordedSurface> = JSON.parse(readFileSync(resolve(sdkRoot, `src/surface.json`), `utf8`));

// IntenticApi is a type, so there is nothing to enumerate at runtime — its members come off the source. Depth is
// the indent: prettier holds this file at four spaces, so a top-level member is the only `readonly` at column 4.
const apiMembers = (): string[] => {
    const text = readFileSync(resolve(sdkRoot, `src/api.ts`), `utf8`);
    const start = text.indexOf(`export interface IntenticApi {`);
    const open = text.indexOf(`{`, start);
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i++) {
        if (text[i] === `{`) depth++;
        else if (text[i] === `}` && --depth === 0) {
            end = i;
            break;
        }
    }
    return [...text.slice(open + 1, end).matchAll(/^ {4}readonly (\w+)\??:/gm)].map((match) => match[1] ?? ``).toSorted();
};

const liveSurface = (): RecordedSurface => ({
    manifest: Object.keys(ExtensionManifestSchema.shape).toSorted(),
    contributes: Object.keys(ExtensionManifestSchema.shape.contributes.unwrap().shape).toSorted(),
    api: apiMembers(),
    listener: Object.keys(ExtensionManifestSchema.shape.contributes.unwrap().shape.listener.unwrap().shape).toSorted(),
});

test(`the surface this version promises is the surface it has`, () => {
    // A miss here means one of two things, and the fix differs: the surface changed (bump extensionApiVersion in
    // version.ts and add an entry keyed by the new version), or the version was bumped without recording what it
    // now promises (copy the received value in as that entry).
    expect(recorded[extensionApiVersion]).toEqual(liveSurface());
});

test(`every earlier version keeps its own record`, () => {
    // The file is the SDK's surface history and ships with the package, so an author can see what a version they
    // are pinned to actually had. Rewriting an old entry is what this catches: no two versions may record the
    // same surface, because then one of them is lying about what changed.
    const shapes = Object.values(recorded).map((surface) => JSON.stringify(surface));
    expect(new Set(shapes).size).toBe(shapes.length);
});

test(`the SDK README names exactly the contribution points the schema has`, () => {
    // The README's list is what an author reads before they read the schema, and it is the copy that went stale
    // last time — it still said `connectors` long after the host had stopped reading it.
    const readme = readFileSync(resolve(sdkRoot, `README.md`), `utf8`);
    const sentence = /Contribution points:([\s\S]*?), plus the/.exec(readme);
    expect(sentence).not.toBeNull();
    const named = [...(sentence?.[1] ?? ``).matchAll(/`(\w+)`/g)].map((match) => match[1] ?? ``).toSorted();
    expect(named).toEqual(liveSurface().contributes);
});

test(`every file the SDK README points at exists`, () => {
    /* The package split moved the manifest schema and the permissions matcher out of this package, and the
     * README went on linking `src/manifest.ts` and `src/permissions.ts` — two dead links in the first document
     * an extension author reads. Nothing catches a stale relative link but a check like this: it is still valid
     * markdown, still renders, and only fails for the reader.
     *
     * Anchors and external URLs are skipped; what is checked is exactly what can rot when a file moves. */
    const readme = readFileSync(resolve(sdkRoot, `README.md`), `utf8`);
    const links = [...readme.matchAll(/\]\(([^)]+)\)/gu)]
        .map((match) => (match[1] ?? ``).split(`#`)[0] ?? ``)
        .filter((target) => target !== `` && !/^[a-z]+:/u.test(target));
    const broken = links.filter((target) => !existsSync(resolve(sdkRoot, target)));
    expect(broken).toEqual([]);
});
