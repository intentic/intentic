import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Which modules define a stored document, a structural boot step, a raw route table or a leaf slice, read from the source
// text rather than from what a process happened to load: the one discovery scripts/write-indexes.mjs writes
// src/bootstrap/state-registry.ts, src/app-raw-routes.ts and src/bootstrap/slices/slice-registry.ts from, and the
// registry's test checks it against. Never
// shipped. Node imports and erasable types only: scripts/write-indexes.mjs and scripts/conversion-checks-fresh.mjs run it
// with plain `node`, before any tsx starts.

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

// A leaf slice, with the type its members are declared under (its `defineSlice<Members>` argument).
export interface SliceDefinition extends Definition {
    readonly members: string;
}

export interface SourceDefinitions extends StateModules {
    readonly rawRoutes: readonly Definition[];
    readonly slices: readonly SliceDefinition[];
}

// The modules that declare the definers rather than call them, and the indexes this is read into.
const SKIPPED = new Set([
    "store/evolution/documents.ts",
    "store/evolution/state-steps.ts",
    "http/raw-route-server.ts",
    "seams/slice.ts",
    "bootstrap/state-registry.ts",
    "app-raw-routes.ts",
    "bootstrap/slices/slice-registry.ts",
]);

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

const CALL = /\bdefine(Document|Step|RawRoutes|Slice)\s*[<(]/g;
// A slice names its members' type as its one type argument, which the slice registry reads it under.
const EXPORTED = /^export const (\w+) = define(Document|Step|RawRoutes|Slice)\s*(?:<(\w+)>\s*\(|[<(])/gm;

// Every definition under `source` (the package's src/), each kind in module then name order. A definition in any other
// form than `export const name = defineDocument(…)` (or defineStep, defineRawRoutes, defineSlice<Members>) at a module's
// top level throws: an index imports it by that name, and one it cannot name would be a document the boot step never
// sees, a route no table serves, or a slice nothing builds.
export const sourceDefinitions = async (source: string): Promise<SourceDefinitions> => {
    const documents: Definition[] = [];
    const steps: Definition[] = [];
    const rawRoutes: Definition[] = [];
    const slices: SliceDefinition[] = [];
    const listOf = (kind: string): Definition[] => {
        if (kind === "Document") {
            return documents;
        }
        return kind === "Step" ? steps : rawRoutes;
    };
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
        for (const [, name = "", kind = "", members] of exported) {
            if (kind !== "Slice") {
                listOf(kind).push({ module, name });
            } else if (members === undefined) {
                unnamed.push(module);
            } else {
                slices.push({ module, name, members });
            }
        }
    }
    if (unnamed.length > 0) {
        throw new Error(
            `define each stored document, boot step, raw route table and leaf slice as \`export const name = defineDocument(…)\` (or defineStep, defineRawRoutes, defineSlice<Members>) at the top level of its module: ${unnamed.join(", ")}`,
        );
    }
    const byName = (a: Definition, b: Definition): number => a.module.localeCompare(b.module) || a.name.localeCompare(b.name);
    return {
        documents: documents.toSorted(byName),
        steps: steps.toSorted(byName),
        rawRoutes: rawRoutes.toSorted(byName),
        slices: slices.toSorted(byName),
    };
};

// The stored documents and structural boot steps alone, which the shape generator and the registry's test read.
export const stateModules = async (source: string): Promise<StateModules> => {
    const { documents, steps } = await sourceDefinitions(source);
    return { documents, steps };
};

// The first line of the generated shape checks, naming the inputs they were generated from (conversionChecksInputs).
export const CONVERSION_CHECKS_STAMP = "// inputs: ";

/**
 * A digest of everything the generated shape checks are written from: the generator, the frozen shapes, and every
 * document's module and the name it is exported under. Equal digests mean the file `--checks` would write is the one
 * already there, so the typecheck skips loading every document module under tsx to write it again (1.3 to 1.7 s a run,
 * measured 2026-10-02). A key built from a constant in another module is the one input it does not follow; the freeze
 * before every land rewrites the shapes for a moved key, which changes the digest.
 */
export const conversionChecksInputs = async (source: string, documents: readonly Definition[], recordText: string): Promise<string> => {
    const hash = createHash("sha256");
    hash.update(await readFile(join(source, "store", "shapes", "write-state-shapes.ts"), "utf8"));
    hash.update(recordText);
    for (const { module, name } of documents) {
        hash.update(`\0${module}\0${name}\0`);
        hash.update(await readFile(join(source, module), "utf8"));
    }
    return hash.digest("hex");
};
