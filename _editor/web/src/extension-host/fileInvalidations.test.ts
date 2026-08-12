import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { expect, test } from "vitest";

/* THE EXTENSION HALF OF "A PUSH THAT LANDS ON NOTHING".
 *
 * The daemon reports a changed file and names the query keys it made stale; the browser hands those names to
 * invalidateQueries. A name nothing registered under is the quietest failure this system has — the file
 * changes, the daemon reports it, invalidateQueries matches zero entries and returns happily, and the view
 * simply goes on showing what it had. No error, anywhere, ever.
 *
 * The core side of that is guarded (composables/queryKeys.guard.test.ts: every WORKSPACE_STATE_FILES name has a
 * family to land on), and it deliberately stops at the boundary — extension keys are registered through
 * `api.sandbox.key(...)` from the extension's own package, and a registry inside this app cannot enumerate
 * them. That is the right call for a third-party extension, which arrives at runtime.
 *
 * It is not the right call for OURS, which are sitting in this repository. So this asks the same question of
 * them: does every name a first-party manifest promises to invalidate belong to a query that extension actually
 * registers? The daemon's own file-bindings test already checks the other half of the same declaration — that
 * the path is one the watcher reports — and the two together are what make a `contributes.files` entry mean
 * something end to end.
 *
 * Scope note, the same one file-bindings.test.ts carries: only the in-repo builtins can be checked here. The
 * constraint applies to third-party extensions equally, and there is nothing to read until they install. */

const EXTENSIONS_ROOT = join(repoRoot(import.meta.url), `_extensions`);

// Every `.key("name")` an extension's sources register under. A regex over source, like the core guard's read
// of its own registry: precise, and it fails loudly on a key built some other way rather than waving it
// through — which is the right outcome for a name the daemon has to be able to hit exactly.
const registeredKeys = (dir: string): Set<string> => {
    const walk = (from: string): string[] =>
        readdirSync(from, { withFileTypes: true }).flatMap((entry) => {
            const full = join(from, entry.name);
            if (entry.isDirectory()) {
                return entry.name === `node_modules` || entry.name === `dist` ? [] : walk(full);
            }
            return entry.name.endsWith(`.ts`) || entry.name.endsWith(`.vue`) ? [full] : [];
        });
    const keys = new Set<string>();
    for (const file of walk(dir)) {
        for (const match of readFileSync(file, `utf8`).matchAll(/\.key\(\s*["'`]([^"'`]+)["'`]/gu)) {
            keys.add(match[1] ?? ``);
        }
    }
    return keys;
};

const declaringExtensions = (): { name: string; invalidates: string[]; keys: Set<string> }[] =>
    readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            let manifest;
            try {
                manifest = ExtensionManifestSchema.parse(
                    JSON.parse(readFileSync(join(EXTENSIONS_ROOT, entry.name, `intentic-extension.json`), `utf8`)),
                );
            } catch {
                // Not an extension package (the shelf's README, a stray dir) — nothing to check.
                return [];
            }
            const invalidates = [...new Set((manifest.contributes?.files ?? []).flatMap((file) => file.invalidates))];
            if (invalidates.length === 0) {
                return [];
            }
            return [{ name: entry.name, invalidates, keys: registeredKeys(join(EXTENSIONS_ROOT, entry.name, `src`)) }];
        });

test(`the scan finds extensions that declare file invalidations`, () => {
    // Nothing to guard is a broken guard, not a passing one — a moved directory or a manifest that stopped
    // parsing would otherwise read as green.
    expect(declaringExtensions().length).toBeGreaterThan(3);
});

test(`every name a first-party extension invalidates is one it registers a query under`, () => {
    const unlanded = declaringExtensions().flatMap(({ name, invalidates, keys }) =>
        invalidates.filter((key) => !keys.has(key)).map((key) => `${name}: contributes.files invalidates "${key}", which no query in it registers`),
    );
    expect(
        unlanded.toSorted(),
        `register the query under this key with api.sandbox.key(...), or drop the name from the manifest — a push that matches nothing refreshes nothing, silently`,
    ).toEqual([]);
});
