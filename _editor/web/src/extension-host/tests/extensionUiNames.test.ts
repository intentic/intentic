import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { extensionUiNames } from "@intentic/extension-ui/names";
import { z } from "zod";

// CI guard for the extension-ui public surface. hostModules.ts checks names.mjs against the real kit at dev boot (a
// console.error a developer can miss); this fails the build instead. The kit is a `.vue` graph that can't be imported
// in node, so names.mjs is compared statically against the runtime exports declared in src/index.ts. Keep the two in
// sync when adding or removing an export.
//
// The subpaths (`@intentic/extension-ui/format`, …) are a second door onto the same bridge: their published
// `dist/<name>.js` is generated off what src/index.ts re-exports from `./<name>.js`, so a name a subpath file exports
// and the barrel leaves out resolves in-repo (straight to source) and fails to link in a git-installed bundle. Every
// entry in package.json's `exports` is checked, so a new subpath is covered without editing this file.

const kitDir = join(repoRoot(import.meta.url), "_shared/extension-ui");
const indexPath = join(kitDir, "src/index.ts");
const webDir = join(kitDir, "../../_editor/web");

// Runtime exports a subpath file holds back from the bridge on purpose, each with the reason.
const sourceOnly = new Map([
    // Mounting a catalog is the host's job (extension-host/loader.ts); on the bridge it would let one extension
    // overwrite another's words. In-repo tests reach it through the source alias.
    ["i18n", ["registerExtensionMessages"]],
]);

// Runtime (value) export names declared by an `export { … } from "…"` file: excludes `export type { … }` blocks and
// `type X` entries, and resolves `X as Y`/`default as Y` to the exported name Y.
//
// Comments are stripped first: without it a block comment fused to the export after it, since the naive split cut on
// commas inside the comment too.
//
// `from` narrows to the blocks re-exporting that specifier; without it every block counts, as does a declared
// `export const|let|function|class` (the form a subpath file defines its own helpers in).
const runtimeExportNames = (source: string, from?: string): string[] => {
    const names: string[] = [];
    const code = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ``);
    if (from === undefined) {
        for (const declared of code.matchAll(/export\s+(?:async\s+)?(?:const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
            names.push(declared[1] ?? "");
        }
    }
    for (const block of code.matchAll(/export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*"([^"]+)")?/g)) {
        if (block[1]) {
            continue; // `export type { … }` — no runtime binding
        }
        if (from !== undefined && block[3] !== from) {
            continue;
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

// The subpaths package.json publishes, as `[name, source file]`: every `exports` entry with a source condition except
// the barrel itself (`./names` is plain data with none).
const ManifestSchema = z.object({ exports: z.record(z.string(), z.unknown()) });
const SourceEntrySchema = z.object({ "@intentic/src": z.string() });
const subpaths = Object.entries(ManifestSchema.parse(JSON.parse(readFileSync(join(kitDir, "package.json"), "utf8"))).exports).flatMap(
    ([key, entry]) => {
        const parsed = SourceEntrySchema.safeParse(entry);
        return key === "." || !parsed.success ? [] : [[key.slice("./".length), parsed.data["@intentic/src"]] as const];
    },
);

// Proves the manifest was read rather than parsed to nothing, which would pass every check below by checking none.
test("reads the subpaths the kit publishes off its manifest", () => {
    expect(subpaths.map(([name]) => name)).toEqual(expect.arrayContaining(["diff", "format", "i18n", "worker"]));
});

describe.each(subpaths)("the %s subpath", (name, source) => {
    const barrel = readFileSync(indexPath, "utf8");

    test("re-exports every runtime name of its file through the barrel, so its published bridge carries it", () => {
        const held = new Set(sourceOnly.get(name) ?? []);
        const exported = runtimeExportNames(readFileSync(join(kitDir, source), "utf8")).filter((entry) => !held.has(entry));
        const bridged = new Set(runtimeExportNames(barrel, `./${name}.js`));
        expect(exported.filter((entry) => !bridged.has(entry))).toEqual([]);
    });

    // A subpath missing here makes the web app resolve the published bridge, which asks the app itself for names it
    // has not provided yet.
    test("resolves to source in the web app", () => {
        const aliases = readFileSync(join(webDir, "source-aliases.ts"), "utf8");
        expect(aliases).toContain(`"@intentic/extension-ui/${name}": fromRoot("_shared/extension-ui/${source.slice("./".length)}")`);
    });
});
