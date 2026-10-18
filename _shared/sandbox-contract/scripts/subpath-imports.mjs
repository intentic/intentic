#!/usr/bin/env node
// Rewrites imports of the `@intentic/sandbox-contract` barrel into one import per module that declares the names, as
// `@intentic/sandbox-contract/<path under src, no extension>`. Idempotent: a name index.ts itself defines (or re-exports
// from another package) stays on the barrel, and a second run finds nothing to change.
//
//   node _shared/sandbox-contract/scripts/subpath-imports.mjs [--check | --dry-run] [--json] <dir or file>…
//   node _shared/sandbox-contract/scripts/subpath-imports.mjs --slim-index   (once every importer is rewritten)
//
// `--check` exits 1 when anything would change, `--dry-run` writes nothing, and both print the summary a run prints.
// What it cannot rewrite mechanically (a dynamic import whose names span modules, a mock factory it cannot read, a
// namespace used whole) is listed as a site for a person, and that file's other imports are still rewritten.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { literalText, moveNamespace, quoteOf, visitReferences } from "./subpath-imports-references.mjs";

export const BARREL = "@intentic/sandbox-contract";
const PACKAGE_DIR = resolve(import.meta.dirname, "..");
const SOURCE_DIR = join(PACKAGE_DIR, "src");
const INDEX = join(SOURCE_DIR, "index.ts");
const PRINT_WIDTH = 150;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".cache", ".turbo", "out-tsc", "deploy", ".git"]);

const moduleFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return moduleFiles(path);
        }
        return entry.name.endsWith(".ts") && !/\.(?:test|d)\.ts$/.test(entry.name) ? [path] : [];
    });

// Each name an importer may take from the barrel, to the module under src/ that declares it (`schemas/agents`), or null
// when index.ts itself defines it or re-exports it from another package, which the slimmed index keeps. What index.ts
// exports decides first; a name it no longer re-exports (after the slimming, or on a branch from before it) is found in
// the one module that declares it, and a name several modules declare is left out, for a person to place.
export const declaringModules = (index = INDEX) => {
    const sourceDir = dirname(index);
    const program = ts.createProgram(moduleFiles(sourceDir), {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2024,
        customConditions: ["@intentic/src"],
        skipLibCheck: true,
        noEmit: true,
        types: [],
    });
    const checker = program.getTypeChecker();
    // The module declaring what a symbol names, null for index.ts or another package.
    const declaredIn = (exported) => {
        const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const files = [...new Set((target.declarations ?? []).map((declaration) => declaration.getSourceFile().fileName))];
        if (files.length !== 1) {
            throw new Error(`${exported.name} is declared in ${files.length === 0 ? "no file" : files.join(" and ")}; name its module by hand`);
        }
        const inside = relative(sourceDir, files[0]);
        const own = resolve(files[0]) === resolve(index) || inside.startsWith("..") || isAbsolute(inside) || files[0].endsWith(".d.ts");
        return own ? null : inside.replaceAll(sep, "/").replace(/\.tsx?$/, "");
    };
    const exportsOf = (file) => {
        const source = program.getSourceFile(file);
        const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
        return moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
    };
    const modules = new Map(exportsOf(index).map((exported) => [exported.name, declaredIn(exported)]));
    if (modules.size === 0) {
        throw new Error(`cannot read the exports of ${index}`);
    }
    const elsewhere = new Map();
    for (const root of program.getRootFileNames().filter((path) => resolve(path) !== resolve(index))) {
        for (const exported of exportsOf(root)) {
            const module = declaredIn(exported);
            if (!modules.has(exported.name) && module !== null) {
                elsewhere.set(exported.name, new Set([...(elsewhere.get(exported.name) ?? []), module]));
            }
        }
    }
    for (const [name, found] of elsewhere) {
        if (found.size === 1) {
            modules.set(name, [...found][0]);
        }
    }
    return modules;
};

const lineOf = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

// How a file names the barrel and a module: the package specifier, or for a file inside the package a relative path.
const specifierScheme = (file) => {
    const inside = file !== undefined && !relative(SOURCE_DIR, file).startsWith("..") && !isAbsolute(relative(SOURCE_DIR, file));
    if (!inside) {
        return { isBarrel: (specifier) => specifier === BARREL, moduleSpecifier: (module) => `${BARREL}/${module}` };
    }
    const from = dirname(file);
    return {
        isBarrel: (specifier) => specifier.startsWith(".") && resolve(from, specifier).replace(/\.js$/, ".ts") === INDEX,
        moduleSpecifier: (module) => {
            const path = relative(from, join(SOURCE_DIR, `${module}.js`)).replaceAll(sep, "/");
            return path.startsWith(".") ? path : `./${path}`;
        },
    };
};

// An import or export declaration's text, on one line when it fits the repository's print width, else one name a line.
const renderDeclaration = ({ keyword, typeOnly, elements, specifier, quote, indent }) => {
    const head = `${keyword} ${typeOnly ? "type " : ""}`;
    const tail = ` from ${quote}${specifier}${quote};`;
    const commented = elements.some((element) => element.includes("//") || element.includes("/*"));
    const single = `${head}{ ${elements.join(", ")} }${tail}`;
    if (!commented && indent.length + single.length <= PRINT_WIDTH) {
        return single;
    }
    return `${head}{\n${elements.map((element) => `${indent}    ${element},`).join("\n")}\n${indent}}${tail}`;
};

// An import or export specifier's text, with any comment written before it inside the braces.
const elementText = (element, text, untyped = false) => {
    const comments = (ts.getLeadingCommentRanges(text, element.pos) ?? []).map((range) => text.slice(range.pos, range.end));
    const written = text.slice(element.getStart(), element.end);
    const own = untyped ? written.replace(/^type\s+/, "") : written;
    return comments.length === 0 ? own : `${comments.join(" ")} ${own}`;
};

const emptyStats = () => ({ declarations: 0, splits: 0, moved: 0, mocks: 0, dynamic: 0, namespaces: 0, generated: 0 });
const indentOf = (text, node) => text.slice(text.lastIndexOf("\n", node.getStart()) + 1, node.getStart());

// What one rewrite of one file works on and collects; every step below reads and adds to it.
const contextFor = (text, modules, file) => {
    const kind = file?.endsWith(".tsx") ? ts.ScriptKind.TSX : file !== undefined && /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file ?? "file.ts", text, ts.ScriptTarget.Latest, true, kind);
    const cx = {
        text,
        modules,
        sourceFile,
        ...specifierScheme(file),
        edits: [],
        humans: [],
        stats: emptyStats(),
        // Existing named declarations of a module subpath, so names moving there join them rather than repeat it.
        existing: new Map(),
        // Planned output, keyed like `existing`: the declarations a barrel import becomes, written where it stood.
        created: new Map(),
        replaced: new Map(),
        namespaceImports: new Map(),
        mockedNamespaces: new Map(),
    };
    cx.human = (node, why) => cx.humans.push({ line: lineOf(sourceFile, node), why });
    cx.replaceSpecifier = (literal, module) => {
        const quote = quoteOf(literal, text);
        cx.edits.push({ start: literal.getStart(), end: literal.end, text: `${quote}${cx.moduleSpecifier(module)}${quote}` });
    };
    // A generator's template of an import line is rewritten as source of its own (generatedImport).
    cx.rewrite = (source) => rewriteSource(source, modules);
    return cx;
};

const namedClause = (statement) => (ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause);
const isTypeOnlyDeclaration = (statement) => (ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly);
const keywordOf = (statement) => (ts.isImportDeclaration(statement) ? "import" : "export");

// Sorts the file's import and export declarations into the barrel's, and the named ones of other specifiers.
const collectDeclarations = (cx) => {
    const barrel = [];
    for (const statement of cx.sourceFile.statements) {
        const specifier =
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined
                ? literalText(statement.moduleSpecifier)
                : undefined;
        if (specifier === undefined) {
            continue;
        }
        if (cx.isBarrel(specifier)) {
            barrel.push(statement);
            continue;
        }
        const named = namedClause(statement);
        const plain = !ts.isImportDeclaration(statement) || statement.importClause?.name === undefined;
        if (named !== undefined && (ts.isNamedImports(named) || ts.isNamedExports(named)) && plain) {
            cx.existing.set(`${keywordOf(statement)}|${isTypeOnlyDeclaration(statement)}|${specifier}`, { statement, added: [] });
        }
    }
    return barrel;
};

// Why a barrel declaration cannot be split by name, or undefined when it can (a namespace import is held for later).
const unsplittable = (cx, statement) => {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (ts.isImportDeclaration(statement) && clause === undefined) {
        return "side-effect import of the barrel";
    }
    if (clause?.name !== undefined) {
        return "default import of the barrel, which has no default export";
    }
    const named = namedClause(statement);
    if (named === undefined) {
        return "`export *` from the barrel re-exports every module; name them";
    }
    if (ts.isNamespaceExport(named)) {
        return "`export * as` the barrel";
    }
    if (ts.isNamespaceImport(named)) {
        cx.namespaceImports.set(named.name.text, { statement, binding: named.name });
        return "";
    }
    return undefined;
};

// A declaration's names by the module that declares each, null for the ones that stay on the barrel.
const groupByModule = (cx, named) => {
    const groups = new Map();
    for (const element of named.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (!cx.modules.has(name)) {
            cx.human(element, `\`${name}\` is declared by no module of the contract, or by several`);
        }
        const module = cx.modules.get(name) ?? null;
        groups.set(module, [...(groups.get(module) ?? []), element]);
    }
    return groups;
};

const countSplit = (stats, groups) => {
    const moved = [...groups].filter(([module]) => module !== null);
    stats.declarations += 1;
    stats.splits += moved.length;
    stats.moved += moved.reduce((sum, [, list]) => sum + list.length, 0);
};

// Plans the declarations one barrel declaration becomes: joined to one already there, or new where it stood.
const planSplit = (cx, statement) => {
    const why = unsplittable(cx, statement);
    if (why !== undefined) {
        if (why !== "") {
            cx.human(statement, why);
        }
        return;
    }
    const groups = groupByModule(cx, namedClause(statement));
    if (groups.size === 1 && groups.has(null)) {
        return;
    }
    countSplit(cx.stats, groups);
    const keyword = keywordOf(statement);
    const typeOnly = isTypeOnlyDeclaration(statement);
    const shared = { keyword, quote: quoteOf(statement.moduleSpecifier, cx.text), indent: indentOf(cx.text, statement) };
    const own = [];
    for (const [module, members] of groups) {
        const specifier = module === null ? literalText(statement.moduleSpecifier) : cx.moduleSpecifier(module);
        // Names that are all `type` become an `import type`, which leaves no side-effect import of the module behind.
        const types = !typeOnly && members.every((element) => element.isTypeOnly);
        const elements = members.map((element) => elementText(element, cx.text, types));
        const key = `${keyword}|${typeOnly || types}|${specifier}`;
        const target = (module === null ? undefined : cx.existing.get(key)) ?? cx.created.get(key);
        if (target !== undefined) {
            target.added.push(...elements);
            continue;
        }
        const entry = { ...shared, typeOnly: typeOnly || types, specifier, elements, added: [] };
        cx.created.set(key, entry);
        own.push(entry);
    }
    cx.replaced.set(statement, own);
};

// A replaced declaration becomes the declarations it owns, or goes with its line when every name joined another.
const writeReplaced = (cx, statement, own) => {
    const { text } = cx;
    if (own.length > 0) {
        const rendered = own.map((entry) => renderDeclaration({ ...entry, elements: [...entry.elements, ...entry.added] }));
        cx.edits.push({ start: statement.getStart(), end: statement.end, text: rendered.join(`\n${own[0].indent}`) });
        return;
    }
    const lineStart = text.lastIndexOf("\n", statement.getStart()) + 1;
    const found = text.indexOf("\n", statement.end);
    const lineEnd = found === -1 ? text.length : found;
    const alone = text.slice(lineStart, statement.getStart()).trim() === "" && text.slice(statement.end, lineEnd).trim() === "";
    cx.edits.push(
        alone
            ? { start: lineStart, end: Math.min(lineEnd + 1, text.length), text: "" }
            : { start: statement.getStart(), end: statement.end, text: "" },
    );
};

// An existing declaration that names moved into, written again with them.
const writeJoined = (cx, { statement, added }) => {
    const have = namedClause(statement).elements.map((element) => elementText(element, cx.text));
    const fresh = added.filter((element) => !have.includes(element));
    if (fresh.length === 0) {
        return;
    }
    const text = renderDeclaration({
        keyword: keywordOf(statement),
        typeOnly: isTypeOnlyDeclaration(statement),
        elements: [...have, ...fresh],
        specifier: literalText(statement.moduleSpecifier),
        quote: quoteOf(statement.moduleSpecifier, cx.text),
        indent: indentOf(cx.text, statement),
    });
    cx.edits.push({ start: statement.getStart(), end: statement.end, text });
};

const applyEdits = (text, edits) =>
    edits.toSorted((a, b) => b.start - a.start).reduce((output, edit) => `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`, text);

// One file's text rewritten, with what it did and what it left for a person. `modules` is declaringModules()'s map.
export const rewriteSource = (text, modules, file) => {
    const cx = contextFor(text, modules, file);
    for (const statement of collectDeclarations(cx)) {
        planSplit(cx, statement);
    }
    visitReferences(cx, cx.sourceFile);
    for (const [name, held] of cx.namespaceImports) {
        moveNamespace(cx, name, held);
    }
    for (const [statement, own] of cx.replaced) {
        writeReplaced(cx, statement, own);
    }
    for (const joined of cx.existing.values()) {
        writeJoined(cx, joined);
    }
    const output = applyEdits(text, cx.edits);
    return { text: output, changed: output !== text, humans: cx.humans, stats: cx.stats };
};

// The `<script>` blocks of a single-file component, each rewritten in place.
export const rewriteFile = (file, text, modules) => {
    if (!file.endsWith(".vue")) {
        return rewriteSource(text, modules, file);
    }
    const total = {
        text,
        changed: false,
        humans: [],
        stats: emptyStats(),
    };
    const blocks = [...text.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g)].toReversed();
    for (const block of blocks) {
        const start = block.index + block[1].length;
        const body = block[2];
        const result = rewriteSource(body, modules, `${file}.ts`);
        const offset = text.slice(0, start).split("\n").length - 1;
        total.humans.push(...result.humans.map((site) => ({ ...site, line: site.line + offset })));
        for (const [key, value] of Object.entries(result.stats)) {
            total.stats[key] += value;
        }
        if (result.changed) {
            total.text = `${total.text.slice(0, start)}${result.text}${total.text.slice(start + body.length)}`;
            total.changed = true;
        }
    }
    total.humans.sort((a, b) => a.line - b.line);
    return total;
};

// index.ts without its re-exports of the package's own modules (and the comments written above them): what is left is
// what it defines, and what it re-exports from another package.
export const slimIndex = (text) => {
    const sourceFile = ts.createSourceFile(INDEX, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const removed = sourceFile.statements.filter(
        (statement) =>
            ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && literalText(statement.moduleSpecifier)?.startsWith("."),
    );
    let output = text;
    for (const statement of removed.toReversed()) {
        const lineStart = text.lastIndexOf("\n", statement.getStart()) + 1;
        const comments = ts.getLeadingCommentRanges(text, statement.pos) ?? [];
        const attached = comments.filter((range) => !/\n\s*\n/.test(text.slice(range.end, statement.getStart())));
        const start = attached.length === 0 ? lineStart : text.lastIndexOf("\n", attached[0].pos) + 1;
        const end = text.indexOf("\n", statement.end) + 1 || text.length;
        output = `${output.slice(0, start)}${output.slice(end)}`;
    }
    return output.replace(/\n{3,}/g, "\n\n");
};

const filesUnder = (path) => {
    const stat = statSync(path);
    if (stat.isFile()) {
        return CODE_FILE.test(path) ? [path] : [];
    }
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? SKIPPED_DIRS.has(entry.name)
                ? []
                : filesUnder(join(path, entry.name))
            : CODE_FILE.test(entry.name)
              ? [join(path, entry.name)]
              : [],
    );
};

const slimCommand = (flags) => {
    const writing = !flags.has("--check") && !flags.has("--dry-run");
    const text = readFileSync(INDEX, "utf8");
    const slim = slimIndex(text);
    if (writing) {
        writeFileSync(INDEX, slim);
    }
    console.log(`subpath-imports: index.ts ${text.split("\n").length} → ${slim.split("\n").length} lines${writing ? "" : " (not written)"}`);
    return flags.has("--check") && slim !== text ? 1 : 0;
};

// The files a run reads: under the targets, naming the contract, never index.ts nor this tool's own fixtures.
const candidates = (targets) =>
    [...new Set(targets.flatMap((target) => filesUnder(resolve(target))))]
        .toSorted()
        .filter((file) => resolve(file) !== INDEX && !resolve(file).startsWith(join(PACKAGE_DIR, "scripts", "subpath-imports")));

const readsContract = (file, text) => text.includes("sandbox-contract") || (file.startsWith(SOURCE_DIR) && text.includes("index.js"));

// Rewrites (or, without `writing`, only measures) every candidate file, totalling what it did.
const rewriteAll = (files, writing) => {
    const modules = declaringModules();
    const totals = { scanned: 0, rewritten: 0, ...emptyStats() };
    const changed = [];
    const humans = [];
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (!readsContract(file, text)) {
            continue;
        }
        totals.scanned += 1;
        const result = rewriteFile(file, text, modules);
        for (const [key, value] of Object.entries(result.stats)) {
            totals[key] += value;
        }
        humans.push(...result.humans.map((site) => ({ file: relative(process.cwd(), file), ...site })));
        if (result.changed) {
            totals.rewritten += 1;
            changed.push(relative(process.cwd(), file));
            if (writing) {
                writeFileSync(file, result.text);
            }
        }
    }
    return { totals, changed, humans };
};

const report = ({ totals, changed, humans }, flags, writing) => {
    if (flags.has("--json")) {
        console.log(JSON.stringify({ ...totals, files: changed, humans }, undefined, 2));
        return;
    }
    console.log(
        `subpath-imports: ${writing ? "rewrote" : "would rewrite"} ${totals.rewritten} of ${totals.scanned} files reading the contract: ` +
            `${totals.declarations} declarations split into ${totals.splits} module imports (${totals.moved} names), ${totals.namespaces} namespace ` +
            `imports, ${totals.dynamic} dynamic imports and ${totals.mocks} mocks and ${totals.generated} generator templates moved; ` +
            `${humans.length} sites need a person`,
    );
    const lines = [
        ...humans.map((site) => `  ${site.file}:${site.line}  ${site.why}`),
        ...(flags.has("--dry-run") ? changed.map((file) => `  ~ ${file}`) : []),
    ];
    for (const line of lines) {
        console.log(line);
    }
};

const main = (argv) => {
    const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
    const targets = argv.filter((arg) => !arg.startsWith("--"));
    if (flags.has("--slim-index")) {
        return slimCommand(flags);
    }
    if (targets.length === 0) {
        console.error("usage: subpath-imports.mjs [--check | --dry-run] [--json] <dir or file>…  |  --slim-index");
        return 2;
    }
    const writing = !flags.has("--check") && !flags.has("--dry-run");
    const run = rewriteAll(candidates(targets), writing);
    report(run, flags, writing);
    return flags.has("--check") && run.totals.rewritten > 0 ? 1 : 0;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = main(process.argv.slice(2));
}
