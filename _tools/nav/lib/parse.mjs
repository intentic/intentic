// Parses one file syntactically (`ts.createSourceFile`), not a full `ts.Program`, so it runs in milliseconds on a tree
// that does not currently build; `resolve.mjs` follows re-exports across files instead.
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

// Cyclomatic complexity of one subtree: one for entry, one per decision point, one per short-circuit operator.
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

// Depth of the deepest nested block; counts blocks only, not every node, so a deeply nested object literal doesn't
// inflate it.
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

// Length of an `if`/`else if`/… chain, a plain `else` counts as one more branch. Not type-aware, so it is an upper
// bound on what a dispatch table could replace.
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

// Every function in a file, however spelled; nested functions are reported separately from their parent, not folded
// into it.
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

// Top-level declarations an import can name; a `const` statement with three names yields three entries sharing one
// span.
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

// Module graph edges `resolve.mjs` follows a name through: `export * from` and `export { x } from` mean the defining
// file isn't always the import path.
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

// Handles `export { a, b as c } from "./x"` and local `export { d }` together; presence of `from` decides re-export vs.
// local name.
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

// A `const` export statement can declare multiple names in one statement; a function or class export declares one.
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
