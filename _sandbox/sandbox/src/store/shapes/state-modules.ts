import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Which modules define a stored document or a structural boot step, read from the source text rather than from what a
// process happened to load: the one discovery the registry generator (write-state-shapes.ts) writes
// src/state-registry.ts from, and the registry's test checks it against. Never shipped.

export interface Definition {
    // Package-relative to src/, forward slashes, with its .ts extension.
    readonly module: string;
    // The name the module exports the definition under.
    readonly name: string;
}

export interface StateModules {
    readonly documents: readonly Definition[];
    readonly steps: readonly Definition[];
}

// The engine's own modules, which declare the definers rather than call them, and the registry this is read into.
const SKIPPED = new Set(["store/evolution/documents.ts", "store/evolution/state-steps.ts", "state-registry.ts"]);

// Every source module the daemon ships, tests, fixtures and generated trees aside.
const sourceFiles = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return entry.name === "generated" || entry.name === "shapes" ? [] : sourceFiles(path);
            }
            return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
        }),
    );
    return nested.flat();
};

const CALL = /\bdefine(Document|Step)\s*[<(]/g;
const EXPORTED = /^export const (\w+) = define(Document|Step)\s*[<(]/gm;

// Every definition under `source` (the package's src/), in module then name order. A definition in any other form
// than `export const name = defineDocument(…)` at a module's top level throws: the registry imports it by that name,
// and one it cannot name would be a document the boot step and the pre-flight never see.
export const stateModules = async (source: string): Promise<StateModules> => {
    const documents: Definition[] = [];
    const steps: Definition[] = [];
    const unnamed: string[] = [];
    for (const file of (await sourceFiles(source)).toSorted()) {
        const module = relative(source, file).split("\\").join("/");
        if (SKIPPED.has(module)) {
            continue;
        }
        const text = await readFile(file, "utf8");
        const calls = [...text.matchAll(CALL)].length;
        const exported = [...text.matchAll(EXPORTED)];
        if (calls !== exported.length) {
            unnamed.push(module);
        }
        for (const [, name = "", kind] of exported) {
            (kind === "Document" ? documents : steps).push({ module, name });
        }
    }
    if (unnamed.length > 0) {
        throw new Error(`define each stored document and boot step as \`export const name = defineDocument(…)\` (or defineStep) at the top level of its module: ${unnamed.join(", ")}`);
    }
    const byName = (a: Definition, b: Definition): number => a.module.localeCompare(b.module) || a.name.localeCompare(b.name);
    return { documents: documents.toSorted(byName), steps: steps.toSorted(byName) };
};
