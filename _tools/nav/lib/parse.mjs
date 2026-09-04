/* THE SHAPE OF ONE FILE, READ SYNTACTICALLY.
 *
 * WHY NO TYPE CHECKER. A full `ts.Program` over 78 packages needs every tsconfig to resolve and every
 * dependency to be installed, takes minutes, and dies on a tree that does not currently build — which is
 * exactly the tree you most want to measure, halfway through a refactor. `ts.createSourceFile` needs none of
 * that: it parses one file in isolation, in milliseconds, and answers every question this harness asks. The
 * one thing a checker would add is following an imported name to its definition across a re-export, and
 * `resolve.mjs` does that from the export tables instead, deterministically and without a build.
 *
 * WHAT IS MEASURED, and why each one is here rather than being a metric somebody liked the sound of:
 *
 *   declaration spans   the size of the thing an agent came to read, as against the size of the file it has
 *                       to open to reach it. The gap between those two IS the navigability problem.
 *   siblings            how many unrelated top-level declarations share the file. This is what makes a lookup
 *                       expensive even when the symbol itself is small.
 *   function length     the p95 is the number that moves when a god function is decomposed; the max is the
 *                       one that shames a codebase.
 *   cyclomatic          a proxy for how much of a function you must hold in your head at once. Counted the
 *                       standard way: one per decision point, one per short-circuit operator.
 *   nesting             depth of the deepest block. Correlates with complexity but is not the same: a flat
 *                       switch with 40 cases is complex and shallow, and reads fine.
 *   if/else-if chains   the specific shape a dispatch table replaces. Counting them is how you tell whether a
 *                       refactor actually did that or just moved the ladder somewhere else. */
import ts from "typescript";
import { vueScript } from "./files.mjs";

const SCRIPT_KIND = {
    ".ts": ts.ScriptKind.TS,
    ".mts": ts.ScriptKind.TS,
    ".cts": ts.ScriptKind.TS,
    ".tsx": ts.ScriptKind.TSX,
    ".vue": ts.ScriptKind.TS,
    ".mjs": ts.ScriptKind.JS,
    ".cjs": ts.ScriptKind.JS,
    ".js": ts.ScriptKind.JS,
};

export const parseFile = (path, text) => {
    const dot = path.lastIndexOf(".");
    const extension = dot === -1 ? ".ts" : path.slice(dot);
    const body = extension === ".vue" ? vueScript(text).code : text;
    const kind = SCRIPT_KIND[extension] ?? ts.ScriptKind.TS;
    return ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true, kind);
};

const DECISION_KINDS = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ConditionalExpression,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.CaseClause,
    ts.SyntaxKind.CatchClause,
]);

const SHORT_CIRCUIT = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

// Cyclomatic complexity of one subtree. One for the entry, one per decision point, one per short-circuit —
// the standard count, so the numbers mean the same thing they mean everywhere else.
export const complexityOf = (node) => {
    let score = 1;
    const walk = (current) => {
        if (DECISION_KINDS.has(current.kind)) {
            score += 1;
        }
        if (ts.isBinaryExpression(current) && SHORT_CIRCUIT.has(current.operatorToken.kind)) {
            score += 1;
        }
        ts.forEachChild(current, walk);
    };
    walk(node);
    return score;
};

const BLOCK_KINDS = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.CaseBlock, ts.SyntaxKind.ModuleBlock]);

// Depth of the deepest nested block in a subtree. Counted on blocks rather than on every node, so an object
// literal three levels deep does not read as pyramid code.
export const nestingOf = (node) => {
    let deepest = 0;
    const walk = (current, depth) => {
        const next = BLOCK_KINDS.has(current.kind) ? depth + 1 : depth;
        if (next > deepest) {
            deepest = next;
        }
        ts.forEachChild(current, (child) => walk(child, next));
    };
    walk(node, 0);
    return deepest;
};

/* Length of the longest `if / else if / else if …` chain in a subtree, counting branches. An `if` with a
 * plain `else` is two; a five-way ladder is five. Only chains keyed on the same subject are worth replacing
 * with a table, but distinguishing those needs types, so this counts them all and the number is read as an
 * upper bound. */
export const longestChain = (node) => {
    let longest = 0;
    const walk = (current, insideChain) => {
        if (ts.isIfStatement(current) && !insideChain) {
            let branches = 1;
            let tail = current.elseStatement;
            while (tail && ts.isIfStatement(tail)) {
                branches += 1;
                tail = tail.elseStatement;
            }
            if (tail) {
                branches += 1;
            }
            if (branches > longest) {
                longest = branches;
            }
        }
        ts.forEachChild(current, (child) => walk(child, ts.isIfStatement(current)));
    };
    walk(node, false);
    return longest;
};

const isFunctionLike = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node);

const nameOf = (node) => {
    if (node.name && ts.isIdentifier(node.name)) {
        return node.name.text;
    }
    // `export const foo = () => …` — the name lives on the variable, not on the arrow.
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
    }
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
    }
    return "";
};

const lineSpan = (source, node) => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
    return { startLine: start + 1, endLine: end + 1, lines: end - start + 1 };
};

/* Every function in a file, however it was spelled. Nested functions are reported separately from their
 * parent rather than being folded into it, so a 600-line function holding six 90-line closures reads as what
 * it is: one very long function AND six long ones. */
export const functionsOf = (source) => {
    const found = [];
    const walk = (node) => {
        if (isFunctionLike(node)) {
            const span = lineSpan(source, node);
            found.push({
                name: nameOf(node) || "<anonymous>",
                ...span,
                complexity: complexityOf(node),
                nesting: nestingOf(node),
            });
        }
        ts.forEachChild(node, walk);
    };
    ts.forEachChild(source, walk);
    return found;
};

// A table rather than an if-ladder, which is the shape this harness exists to encourage and would be
// embarrassing to violate in the harness itself.
const DECLARATION_KINDS = new Map([
    [ts.SyntaxKind.FunctionDeclaration, "function"],
    [ts.SyntaxKind.ClassDeclaration, "class"],
    [ts.SyntaxKind.InterfaceDeclaration, "interface"],
    [ts.SyntaxKind.TypeAliasDeclaration, "type"],
    [ts.SyntaxKind.EnumDeclaration, "enum"],
    [ts.SyntaxKind.VariableStatement, "const"],
]);

const declarationKind = (node) => DECLARATION_KINDS.get(node.kind) ?? "";

const hasExportModifier = (node) =>
    (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/* Top-level declarations, which are the things an import can name. A `const` statement declaring three names
 * yields three entries sharing one span: that is honest, because reading any of them costs the whole
 * statement. */
export const declarationsOf = (source) => {
    const found = [];
    for (const node of source.statements) {
        const kind = declarationKind(node);
        if (!kind) {
            continue;
        }
        const span = lineSpan(source, node);
        const exported = hasExportModifier(node);
        const complexity = complexityOf(node);

        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    found.push({ name: declaration.name.text, kind, exported, complexity, ...span });
                }
            }
            continue;
        }
        if (node.name && ts.isIdentifier(node.name)) {
            found.push({ name: node.name.text, kind, exported, complexity, ...span });
        }
    }
    return found;
};

/* The module graph edges this file contributes, and the export table `resolve.mjs` needs to follow a name to
 * the file that actually defines it. `export * from` and `export { x } from` are the two shapes that make a
 * naive "the import path is where it lives" assumption wrong. */
const importedNames = (clause) => {
    const names = [];
    if (clause?.name) {
        names.push({ imported: "default", local: clause.name.text });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
            names.push({ imported: element.propertyName?.text ?? element.name.text, local: element.name.text });
        }
    }
    return names;
};

// `export { a, b as c } from "./x"` and `export { d }` in one shape: the presence of `from` is what decides
// whether each element is a re-export edge to follow or a local name this file owns.
const collectExportClause = (node, from, reexports, localExports) => {
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
        return;
    }
    for (const element of node.exportClause.elements) {
        const original = element.propertyName?.text ?? element.name.text;
        if (from) {
            reexports.push({ name: element.name.text, from, sourceName: original });
        } else {
            localExports.add(element.name.text);
        }
    }
};

// `export const a = 1, b = 2` declares two names on one statement; `export function f` declares one.
const collectExportedDeclaration = (node, localExports) => {
    if (ts.isVariableStatement(node)) {
        const named = node.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name));
        for (const declaration of named) {
            localExports.add(declaration.name.text);
        }
        return;
    }
    if (node.name && ts.isIdentifier(node.name)) {
        localExports.add(node.name.text);
    }
};

export const moduleFactsOf = (source) => {
    const imports = [];
    const reexports = [];
    const stars = [];
    const localExports = new Set();

    for (const node of source.statements) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            imports.push({
                specifier: node.moduleSpecifier.text,
                names: importedNames(node.importClause),
                typeOnly: node.importClause?.isTypeOnly === true,
            });
            continue;
        }

        if (ts.isExportDeclaration(node)) {
            const from = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
            if (!node.exportClause && from) {
                stars.push(from);
                continue;
            }
            collectExportClause(node, from, reexports, localExports);
            continue;
        }

        if (hasExportModifier(node)) {
            collectExportedDeclaration(node, localExports);
        }
    }

    return { imports, reexports, stars, localExports: [...localExports] };
};
