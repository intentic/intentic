import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { isIconName } from "@intentic/ui/icons";
import { describe, expect, it } from "vitest";

/* EVERY FIRST-PARTY EXTENSION'S MARK NAMES A GLYPH THAT EXISTS.
 *
 * `icon` is an open string in the manifest, because a third-party extension is written against a build that has
 * not shipped and must install anyway — so a typo in one of OURS is not a schema error, not a compile error and
 * not a runtime error either. <BrandMark> falls through to the extension's initials, which looks deliberate and
 * is how the same class of typo already shipped once as a blank rail tile (`book`).
 *
 * Read off DISK rather than off builtins.ts, and that is the point: nine of these extensions contribute no
 * code to this bundle at all (connectors, social, computers, acp-agents, discord, slack, telegram, whatsapp, imap), so a test over
 * the compiled-in modules would check two thirds of the list and quietly skip the third that has nowhere else
 * to be checked. The vocabulary lives in @intentic/ui, which only the browser depends on, so this is the only
 * package that can ask the question.
 *
 * `logo` is deliberately NOT checked: a simple-icons slug can only be confirmed by fetching it, and a test that
 * reaches a CDN fails on a train. A dead slug is the one tier that degrades on its own — the mark underneath is
 * already painted. */

const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const manifests = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
        const path = join(EXTENSIONS_DIR, entry.name, "intentic-extension.json");
        try {
            return [{ dir: entry.name, manifest: ExtensionManifestSchema.parse(JSON.parse(readFileSync(path, "utf8"))) }];
        } catch {
            // A directory here that carries no manifest is not an extension (the docs and test-only packages),
            // and one whose manifest does not parse is a failure the daemon's own suite owns.
            return [];
        }
    });

describe(`first-party extension marks`, () => {
    it(`finds the manifests at all — a glob that silently matches nothing asserts nothing`, () => {
        expect(manifests.length).toBeGreaterThan(15);
    });

    for (const { dir, manifest } of manifests) {
        it(`names an icon this build can draw — ${dir}`, () => {
            const declared = [
                ...(manifest.icon === undefined ? [] : [manifest.icon]),
                ...(manifest.contributes?.capabilities ?? []).flatMap((capability) =>
                    capability.catalog.icon === undefined ? [] : [capability.catalog.icon],
                ),
            ];
            expect(declared.filter((icon) => !isIconName(icon))).toEqual([]);
        });

        /* Something to draw, without exception. An extension that declares neither tier still renders — its
         * initials are the floor — but a FIRST-PARTY one arriving with no mark is an oversight rather than a
         * choice, and the Extensions tab is where it shows: one row in a column of marks wearing two grey
         * letters reads as the one that failed to load. */
        it(`declares a mark — ${dir}`, () => {
            expect(manifest.logo ?? manifest.icon).toBeDefined();
        });
    }
});
