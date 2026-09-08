import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { extensionUiNames } from "@intentic/extension-ui/names";
import { expect, test } from "vitest";

// CI guard for the extension-ui public surface. hostModules.ts checks names.mjs against the real kit at dev boot (a
// console.error a developer can miss); this fails the build instead. The kit is a `.vue` graph that can't be imported
// in node, so names.mjs is compared statically against the runtime exports declared in src/index.ts. Keep the two in
// sync when adding or removing an export.

const indexPath = join(repoRoot(import.meta.url), "_shared/extension-ui/src/index.ts");

// Runtime (value) export names declared by an `export { … } from "…"` file: excludes `export type { … }` blocks and
// `type X` entries, and resolves `X as Y`/`default as Y` to the exported name Y.
//
// Comments are stripped first: without it a block comment fused to the export after it, since the naive split cut on
// commas inside the comment too.
const runtimeExportNames = (source: string): string[] => {
    const names: string[] = [];
    const code = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ``);
    for (const block of code.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
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
