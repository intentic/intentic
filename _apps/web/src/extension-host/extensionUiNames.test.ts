import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionUiNames } from "@intentic/extension-ui/names";
import { expect, test } from "vitest";

/* CI guard for the extension-ui public surface. hostModules.ts asserts names.mjs matches the real kit at DEV
 * boot (a console.error a developer can miss); this fails the build instead. The kit is a .vue graph that can't
 * be imported in node, so — like the shim generator — we compare names.mjs against the runtime (value) exports
 * declared in src/index.ts, statically. Keep the two in sync when adding or removing an export. */

const indexPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../_libs/extension-ui/src/index.ts");

// Runtime (value) export names declared by an `export { … } from "…"` file — excludes `export type { … }` blocks
// and `type X` entries (types are erased, so they aren't in the host-provided module), and resolves `X as Y`/
// `default as Y` to the exported name Y.
const runtimeExportNames = (source: string): string[] => {
    const names: string[] = [];
    for (const block of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
        if (block[1]) {
            continue; // `export type { … }` — no runtime binding
        }
        for (const raw of (block[2] ?? "").split(",")) {
            const entry = raw.trim();
            if (entry === "" || entry.startsWith("type ")) {
                continue;
            }
            const asMatch = /(?:\w+)\s+as\s+(\w+)$/.exec(entry);
            names.push(asMatch ? (asMatch[1] ?? entry) : entry);
        }
    }
    return names;
};

test("names.mjs matches the runtime exports of extension-ui/src/index.ts", () => {
    const declared = new Set(runtimeExportNames(readFileSync(indexPath, "utf8")));
    const listed = new Set(extensionUiNames);
    const missing = [...declared].filter((name) => !listed.has(name));
    const unlisted = [...listed].filter((name) => !declared.has(name));
    expect({ missing, unlisted }).toEqual({ missing: [], unlisted: [] });
});
