import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { isNewer } from "@intentic/sandbox-contract";
import { z } from "zod";
import { type DocumentSpec, documentKey, registeredDocuments } from "../evolution/documents.js";
import { typeFromSchema } from "./json-schema-type.js";

// The shape generator: freezes every shape each stored document has had and writes the type-level checks that each
// frozen shape still converts to what today's schema accepts (store/evolution/conversion-types.ts), so a change that would strand
// an old file fails `tsc` at the document until a conversion covers it. Run by verify-turn's fixer beside the contract
// lock (`node --import tsx src/store/shapes/write-state-shapes.ts`); `--seed` backfills, once, the shapes every release
// since the contract lock existed recorded for contract-exported schemas. Never shipped: excluded from the build.

interface FrozenShape {
    readonly type: string;
    // Where the shape was first seen: a release tag for a seeded one, the UTC day it was frozen otherwise.
    readonly since: string;
}

type Shapes = Record<string, FrozenShape[]>;

const PACKAGE = packageRoot(import.meta.url);
const SOURCE = join(PACKAGE, "src");
const GENERATED = join(SOURCE, "store", "generated");
const SHAPES_FILE = join(GENERATED, "state-shapes.json");
const CHECKS_FILE = join(GENERATED, "state-shapes.ts");
const REPO = repoRoot(import.meta.url);

const git = (...args: string[]): string | undefined => {
    try {
        return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
        // silent-catch: a path absent at a tag, or no git at all, is simply nothing to seed from
        return undefined;
    }
};

// Every path the contract lock has had, asked of git rather than spelled here: its package keeps its own directory name
// while the directory above it moved (the overhaul of 2026-09-06), so one glob finds it at any release.
const lockPaths = (): string[] => [
    ...new Set((git("log", "--all", "--format=", "--name-only", "--", ":(glob)**/sandbox-contract/contract.lock.json") ?? "").split("\n").filter((path) => path !== "")),
];

// Every source module, tests and this generator's own tree aside.
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

interface Located {
    readonly spec: DocumentSpec;
    // Package-relative module path and the name it exports the spec under, for the generated import.
    readonly module: string;
    readonly name: string;
}

// Loads every module that defines a document (some the daemon loads lazily, which composition alone would miss), then
// says which module exports each: the generated checks import it by that name.
const locate = async (): Promise<Located[]> => {
    const exportsOf = new Map<string, Record<string, unknown>>();
    for (const file of await sourceFiles(SOURCE)) {
        if ((await readFile(file, "utf8")).includes("defineDocument(")) {
            exportsOf.set(relative(SOURCE, file), (await import(pathToFileURL(file).href)) as Record<string, unknown>);
        }
    }
    const documents = registeredDocuments();
    const owners = new Map<DocumentSpec, { module: string; name: string }>();
    for (const [module, exported] of exportsOf) {
        for (const [name, value] of Object.entries(exported)) {
            if (documents.includes(value as DocumentSpec)) {
                owners.set(value as DocumentSpec, { module, name });
            }
        }
    }
    const unexported = documents.filter((spec) => !owners.has(spec)).map(documentKey);
    if (unexported.length > 0) {
        throw new Error(`export these documents from the module that defines them, the generated checks import them: ${unexported.join(", ")}`);
    }
    return documents.map((spec) => ({ spec, ...(owners.get(spec) ?? { module: "", name: "" }) }));
};

const shapeOf = (schema: unknown): string => {
    try {
        return typeFromSchema(z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" }));
    } catch {
        // silent-catch: a schema JSON Schema cannot spell freezes as unknown, which every later shape fits
        return "unknown";
    }
};

const append = (shapes: Shapes, key: string, shape: FrozenShape): void => {
    const known = shapes[key] ?? [];
    if (!known.some((frozen) => frozen.type === shape.type)) {
        shapes[key] = [...known, shape];
    }
};

// Every release that carried the contract lock, oldest first, contributing the output shape it recorded for each
// document whose schema the contract exports: exactly what that release wrote to disk.
const seed = async (shapes: Shapes, located: readonly Located[]): Promise<void> => {
    const contract = (await import("@intentic/sandbox-contract")) as Record<string, unknown>;
    const names = new Map<unknown, string>(Object.entries(contract).map(([name, value]) => [value, name]));
    const tags = (git("tag", "--sort=creatordate") ?? "").split("\n").filter((tag) => tag !== "");
    const locks = lockPaths();
    for (const tag of tags) {
        const text = locks.map((path) => git("show", `${tag}:${path}`)).find((found) => found !== undefined);
        if (text === undefined) {
            continue;
        }
        const lock = JSON.parse(text) as Record<string, unknown>;
        for (const { spec } of located) {
            const name = names.get(spec.schema);
            if (name !== undefined && lock[name] !== undefined) {
                append(shapes, documentKey(spec), { type: typeFromSchema(lock[name]), since: tag });
            }
        }
    }
};

const aliasOf = (name: string, index: number): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}${index}`;

// A shape frozen from a release older than the document's horizon is past what this build converts on purpose.
const beforeHorizon = (shape: FrozenShape, horizon: string | undefined): boolean =>
    horizon !== undefined && shape.since.startsWith("v") && isNewer(horizon.replace(/^v/, ""), shape.since.replace(/^v/, ""));

const checksSource = (shapes: Shapes, located: readonly Located[]): string => {
    const byKey = new Map(located.map((entry) => [documentKey(entry.spec), entry]));
    const keys = Object.keys(shapes)
        .filter((key) => byKey.has(key))
        .toSorted();
    const imports = keys
        .map((key) => byKey.get(key))
        .filter((entry): entry is Located => entry !== undefined)
        .toSorted((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name))
        .map(({ module, name }) => `import type { ${name} } from "../../${module.replace(/\.ts$/, ".js")}";`);
    const blocks: string[] = [];
    const checks: string[] = [];
    for (const key of keys) {
        const entry = byKey.get(key);
        if (entry === undefined) {
            continue;
        }
        blocks.push(`// ${key}`);
        (shapes[key] ?? []).forEach((shape, index) => {
            if (beforeHorizon(shape, entry.spec.horizon)) {
                blocks.push(`// since ${shape.since}: before the horizon (${entry.spec.horizon ?? ""}), not converted`);
                return;
            }
            const alias = aliasOf(entry.name, index);
            blocks.push(`// since ${shape.since}`, `type ${alias} = ${shape.type};`);
            checks.push(`Fits<Accepted<typeof ${entry.name}>, Converted<${alias}, typeof ${entry.name}>>`);
        });
        checks.push(`Fits<never, ReusedKeys<typeof ${entry.name}>>`);
        blocks.push("");
    }
    return [
        "// Generated by src/store/shapes/write-state-shapes.ts from state-shapes.json: every shape each stored document has",
        "// had, and the checks that each still converts to what today's schema accepts. Do not edit; run the generator. A",
        "// failure below names the document and property that would strand an old file: add a conversion to its history.",
        'import type { Accepted, Converted, Fits, ReusedKeys } from "../evolution/conversion-types.js";',
        ...imports,
        "",
        ...blocks,
        "export type StateShapeChecks = [",
        ...checks.map((check) => `    ${check},`),
        "];",
        "",
    ].join("\n");
};

const readShapes = async (): Promise<Shapes> => {
    try {
        return JSON.parse(await readFile(SHAPES_FILE, "utf8")) as Shapes;
    } catch {
        // silent-catch: the first run starts from nothing
        return {};
    }
};

const { values } = parseArgs({ options: { seed: { type: "boolean", default: false } } });

// Evaluated for what it registers: every stored document the daemon knows.
await import("../../composition.js");
const located = await locate();
const shapes = await readShapes();
if (values.seed) {
    await seed(shapes, located);
}
const utcDay = new Date().toISOString().slice(0, 10);
for (const { spec } of located) {
    append(shapes, documentKey(spec), { type: shapeOf(spec.schema), since: utcDay });
}
const sorted: Shapes = Object.fromEntries(Object.entries(shapes).toSorted(([a], [b]) => a.localeCompare(b)));
await mkdir(dirname(SHAPES_FILE), { recursive: true });
await writeFile(SHAPES_FILE, `${JSON.stringify(sorted, undefined, 2)}\n`);
await writeFile(CHECKS_FILE, checksSource(sorted, located));
process.stdout.write(`${Object.values(sorted).reduce((sum, list) => sum + list.length, 0)} shapes across ${Object.keys(sorted).length} documents\n`);
// The composition import leaves timers and handles behind that are not this script's to wait for.
process.exit(0);
