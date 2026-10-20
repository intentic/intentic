import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Which modules define a stored document, a structural boot step, a raw route table or a leaf slice, read from the source
// text rather than from what a process happened to load: the one discovery scripts/write-indexes.mjs writes
// src/bootstrap/state-registry.ts, src/app-raw-routes.ts, src/bootstrap/slices/slice-registry.ts and
// src/store/evolution/history-documents.generated.ts from, and the registry's test checks it against. Never
// shipped. Node imports and erasable types only: scripts/write-indexes.mjs and scripts/conversion-checks-fresh.mjs run it
// with plain `node`, before any tsx starts.

export interface Definition {
    // Package-relative to src/, forward slashes, with its .ts extension.
    readonly module: string;
    // The name the module exports the definition under.
    readonly name: string;
}

// What a document on the history volume says of itself at its definition, read off the source text: its path (a
// directory's with its trailing slash), whether it travels in a bundle, and the instruction the bundle report gives the
// owner when it does not.
export interface HistoryDeclaration {
    readonly path: string;
    readonly portability: string;
    readonly note?: string;
}

export interface DocumentDefinition extends Definition {
    // Undefined for a document on any other root.
    readonly history?: HistoryDeclaration;
}

export interface StateModules {
    readonly documents: readonly DocumentDefinition[];
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

// What the scan has found so far, and the modules it could not read a definition of.
interface Found {
    readonly documents: DocumentDefinition[];
    readonly steps: Definition[];
    readonly rawRoutes: Definition[];
    readonly slices: SliceDefinition[];
    readonly unnamed: string[];
    readonly undeclared: string[];
}

const scanModule = (module: string, text: string, found: Found): void => {
    const exported = [...text.matchAll(EXPORTED)];
    if ([...text.matchAll(CALL)].length !== exported.length) {
        found.unnamed.push(module);
    }
    for (const match of exported) {
        const [whole, name = "", kind = "", members] = match;
        const document = kind === "Document" ? declaredDocument({ module, name }, text, (match.index ?? 0) + whole.length) : undefined;
        if (document === "undeclared") {
            found.undeclared.push(`${module} ${name}`);
        } else if (document !== undefined) {
            found.documents.push(document);
        } else if (kind !== "Slice") {
            (kind === "Step" ? found.steps : found.rawRoutes).push({ module, name });
        } else if (members === undefined) {
            found.unnamed.push(module);
        } else {
            found.slices.push({ module, name, members });
        }
    }
};

const refuseUnreadable = ({ unnamed, undeclared }: Found): void => {
    if (unnamed.length > 0) {
        throw new Error(
            `define each stored document, boot step, raw route table and leaf slice as \`export const name = defineDocument(…)\` (or defineStep, defineRawRoutes, defineSlice<Members>) at the top level of its module: ${unnamed.join(", ")}`,
        );
    }
    if (undeclared.length > 0) {
        throw new Error(
            `a document on the history volume says whether it travels in a bundle, as a string literal \`portability\` (and \`note\`, if any) beside its literal \`path\` in its defineDocument: ${undeclared.join(", ")}`,
        );
    }
};

// Every definition under `source` (the package's src/), each kind in module then name order. A definition in any other
// form than `export const name = defineDocument(…)` (or defineStep, defineRawRoutes, defineSlice<Members>) at a module's
// top level throws: an index imports it by that name, and one it cannot name would be a document the boot step never
// sees, a route no table serves, or a slice nothing builds.
export const sourceDefinitions = async (source: string): Promise<SourceDefinitions> => {
    const found: Found = { documents: [], steps: [], rawRoutes: [], slices: [], unnamed: [], undeclared: [] };
    for (const file of (await sourceFiles(source)).toSorted()) {
        const module = relative(source, file).split("\\").join("/");
        if (!SKIPPED.has(module)) {
            scanModule(module, await readFile(file, "utf8"), found);
        }
    }
    refuseUnreadable(found);
    const { documents, steps, rawRoutes, slices } = found;
    const byName = (a: Definition, b: Definition): number => a.module.localeCompare(b.module) || a.name.localeCompare(b.name);
    return {
        documents: documents.toSorted(byName),
        steps: steps.toSorted(byName),
        rawRoutes: rawRoutes.toSorted(byName),
        slices: slices.toSorted(byName),
    };
};

// A property's value as its source spells it: a string literal or a boolean, and "" for anything else.
type Spelled = string;

// The index just past the comment, string or template literal opening at `at`, or undefined when none opens there. A
// template's `${…}` is passed over as text.
const skipped = (text: string, at: number): number | undefined => {
    const char = text[at];
    if (char === "/" && text[at + 1] === "/") {
        return text.indexOf("\n", at);
    }
    if (char === "/" && text[at + 1] === "*") {
        return text.indexOf("*/", at) + 2;
    }
    if (char !== '"' && char !== "'" && char !== "`") {
        return undefined;
    }
    let next = at + 1;
    while (next < text.length && text[next] !== char) {
        next += text[next] === "\\" ? 2 : 1;
    }
    return next + 1;
};

const PROPERTY = /^([A-Za-z_$][\w$]*)\s*(?::\s*("(?:[^"\\]|\\.)*"|true|false)?)?\s*[,}:]/;

// The top-level keys of the object literal the call whose arguments start at `from` opens with, each with its value as
// spelled. A scan, not a parse: it skips strings, template literals and comments, and counts brackets, which is all a
// definition's literal needs.
const literalKeys = (text: string, from: number): ReadonlyMap<string, Spelled> => {
    const keys = new Map<string, Spelled>();
    let depth = 0;
    // The last character that was neither space nor comment: a key follows the brace or a comma.
    let previous = "";
    let at = text.indexOf("{", from);
    while (at !== -1 && at < text.length) {
        const past = skipped(text, at);
        const char = text[at] ?? "";
        if (past !== undefined) {
            previous = char === "/" ? previous : char;
            at = past;
            continue;
        }
        depth += Number("([{".includes(char)) - Number(")]}".includes(char));
        if (depth === 0) {
            return keys;
        }
        const property = depth === 1 && (previous === "{" || previous === ",") ? PROPERTY.exec(text.slice(at, at + 4096)) : null;
        const [, key = "", value = ""] = property ?? [];
        if (key !== "") {
            keys.set(key, value);
        }
        previous = /\s/.test(char) ? previous : char;
        at += Math.max(1, key.length);
    }
    return keys;
};

// The string a spelled value holds, undefined when it is not a string literal.
const stringOf = (spelled: Spelled | undefined): string | undefined =>
    // SAFETY: a value PROPERTY spelled with a double quote is a JSON string literal.
    spelled?.startsWith('"') === true ? (JSON.parse(spelled) as string) : undefined;

// A document's definition with what it declares on the history volume, its arguments starting at `from` in its module's
// text: "undeclared" for one there that does not say whether it travels, as literals beside a literal path.
export const declaredDocument = (definition: Definition, text: string, from: number): DocumentDefinition | "undeclared" => {
    const keys = literalKeys(text, from);
    if (stringOf(keys.get("root")) !== "history") {
        return definition;
    }
    const path = stringOf(keys.get("path"))?.replace(/\/$/, "");
    const portability = stringOf(keys.get("portability"));
    const note = stringOf(keys.get("note"));
    if (path === undefined || portability === undefined || (keys.has("note") && note === undefined)) {
        return "undeclared";
    }
    const declared = { path: keys.get("directory") === "true" ? `${path}/` : path, portability };
    return { ...definition, history: note === undefined ? declared : { ...declared, note } };
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
