import { readFileSync } from "node:fs";
import { join } from "node:path";

/* A WORKSPACE PACKAGE'S SOURCE, THE WAY ITS OWN EXPORTS MAP SAYS IT, for the vitest configs that must read a
 * sibling's source rather than whatever its `dist` happens to hold.
 *
 * WHY THIS EXISTS RATHER THAN ONE ALIAS PER CONFIG. Aliasing the package DIRECTORY —
 * `"@intentic/sandbox-contract": "…/src"` — works only while every subpath export is a file at the top of
 * `src/`: `@intentic/sandbox-contract/session-names` lands on `src/session-names.ts` by coincidence of layout,
 * not by the manifest. The day that file moves into `src/ids/`, the alias resolves to nothing and every suite
 * in the package fails to LOAD, pointing at the importer rather than at the alias. That is exactly what
 * happened when the contract's 96 loose modules were grouped, and it is silent under a typecheck, because
 * tsc reads the exports map that vitest was told to bypass.
 *
 * So the map comes from the manifest: every subpath the package publishes, aimed at the `@intentic/src`
 * condition every workspace package declares. Move a file inside the package, repoint its export, and the
 * suites follow with no config edit at all.
 *
 * ORDER MATTERS. A string alias also matches `<key>/…`, so the barrel has to come LAST or it swallows every
 * subpath and resolves `…/session-names` to `src/index.ts/session-names`, a path that cannot exist. */
type ExportEntry = string | { readonly [condition: string]: ExportEntry | undefined };

const SOURCE_CONDITION = "@intentic/src";

const sourceOf = (entry: ExportEntry | undefined): string | undefined => {
    if (entry === undefined || typeof entry === "string") {
        return undefined;
    }
    const direct = entry[SOURCE_CONDITION];
    if (typeof direct === "string") {
        return direct;
    }
    return sourceOf(entry["import"]);
};

export const packageSourceAliases = (packageDir: string): Record<string, string> => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
        name: string;
        exports?: Record<string, ExportEntry>;
    };
    const entries = Object.entries(manifest.exports ?? {}).flatMap(([subpath, entry]) => {
        const source = sourceOf(entry);
        if (source === undefined || subpath.includes("*")) {
            return [];
        }
        const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.replace(/^\.\//, "")}`;
        return [[specifier, join(packageDir, source.replace(/^\.\//, ""))] as const];
    });
    return Object.fromEntries([...entries.filter(([specifier]) => specifier !== manifest.name), ...entries.filter(([specifier]) => specifier === manifest.name)]);
};
