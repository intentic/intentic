import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { expect, test } from "vitest";

// Checks the extension half of "a push that lands on nothing": an invalidated name nothing is registered under fails
// silently, and the view just keeps its stale state.
// composables/queryKeys.guard.test.ts checks the core side; this checks first-party extensions, since a runtime
// registry can't enumerate third-party ones.
// Only in-repo builtins can be checked here; third-party extensions have nothing to read until installed.

const EXTENSIONS_ROOT = join(repoRoot(import.meta.url), `_extensions`);

// Every `.key("name")` call an extension's sources register, found by scanning source text; a key built another way is
// not detected.
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
                // Not an extension package (the shelf's README, a stray dir): nothing to check.
                return [];
            }
            const invalidates = [...new Set((manifest.contributes?.files ?? []).flatMap((file) => file.invalidates))];
            if (invalidates.length === 0) {
                return [];
            }
            return [{ name: entry.name, invalidates, keys: registeredKeys(join(EXTENSIONS_ROOT, entry.name, `src`)) }];
        });

test(`the scan finds extensions that declare file invalidations`, () => {
    // Zero found means the guard broke (moved dir, bad manifest), not that there's nothing to check.
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
