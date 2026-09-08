import { readFileSync } from "node:fs";
import { join } from "node:path";

// Aliases each of a package's subpath exports to its source, from the manifest's `@intentic/src` condition, not the
// whole package directory, since a directory alias breaks silently once a file moves out of `src`'s top level. The `.`
// (barrel) alias must sort last: a string alias also matches `<key>/…` and would swallow every subpath into it.
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
