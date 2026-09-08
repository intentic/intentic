import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { artSrc } from "@intentic/ui/brand-mark";
import { isIconName } from "@intentic/ui/icons";
import { describe, expect, it } from "vitest";

// Every first-party extension's mark names a glyph that exists. `icon` is an open string in the manifest, so a typo in
// one of ours is not a schema, compile, or runtime error; <BrandMark> falls through to initials, which looks
// deliberate.
//
// Read off disk rather than off builtins.ts: many of these extensions contribute no code to this bundle at all, so a
// test over the compiled-in modules would silently skip the third of the list with nowhere else to be checked.
//
// `logo` is not checked, since a simple-icons slug can only be confirmed by fetching it and a test that reaches a CDN
// fails on a train; a dead slug degrades on its own. `art` is checked, since its whole document is already here and
// costs nothing to verify.

const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const manifests = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
        const path = join(EXTENSIONS_DIR, entry.name, "intentic-extension.json");
        try {
            return [{ dir: entry.name, manifest: ExtensionManifestSchema.parse(JSON.parse(readFileSync(path, "utf8"))) }];
        } catch {
            // A directory here with no manifest is not an extension (docs and test-only packages); one whose manifest
            // doesn't parse is a failure the daemon's own suite owns.
            return [];
        }
    });

describe(`first-party extension marks`, () => {
    it(`finds the manifests at all: a glob that silently matches nothing asserts nothing`, () => {
        expect(manifests.length).toBeGreaterThan(15);
    });

    for (const { dir, manifest } of manifests) {
        it(`names an icon this build can draw: ${dir}`, () => {
            const declared = [
                ...(manifest.icon === undefined ? [] : [manifest.icon]),
                ...(manifest.contributes?.capabilities ?? []).flatMap((capability) =>
                    capability.catalog.icon === undefined ? [] : [capability.catalog.icon],
                ),
            ];
            expect(declared.filter((icon) => !isIconName(icon))).toEqual([]);
        });

        // An extension declaring no tier still renders on its initials as the floor, but a first-party one arriving
        // with no mark at all is an oversight, not a choice, and the Extensions tab is where it shows.
        it(`declares a mark: ${dir}`, () => {
            expect(manifest.art ?? manifest.logo ?? manifest.icon).toEqual(expect.any(String));
        });

        // Artwork that would not survive the gate is worse than none, since it falls back silently and the author never
        // learns the drawing they shipped isn't being drawn. Checked here, calling the same function <BrandMark> calls,
        // since "is a drawable SVG" is not something zod can say about a string.
        it(`declares artwork this build will actually paint: ${dir}`, () => {
            if (manifest.art === undefined) {
                return;
            }
            expect(artSrc(manifest.art), `contributes art that is not a drawable SVG document`).toEqual(expect.any(String));
        });
    }
});
