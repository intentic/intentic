// The half of subpath-imports.mjs that reads the barrel where it is named outside an import or export declaration: a
// dynamic `import(…)`, a mock factory, a generator's template of an import line, an `import(…)` type, and a namespace
// import read off across the file. Each moves to the one module its names come from or is listed for a person.
import ts from "typescript";

// A string holding an import line of the barrel, as a generator writes one.
const WRITTEN_IMPORT = /^\s*(?:import|export)\b[^\n]*\bfrom\s*["'`]@intentic\/sandbox-contract["'`];?\s*$/;
const MOCKERS = new Set(["jest.mock", "mock.module", "vi.mock", "vi.doMock", "jest.doMock"]);

export const quoteOf = (literal, text) => text[literal.getStart()] ?? `"`;
export const literalText = (node) => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined);

// What `ns.x`, `ns.X` (in a type) and `typeof ns` read off a namespace binding across the file; `whole` is any other use.
const namespaceUses = (sourceFile, name, binding) => {
    const names = new Set();
    const whole = [];
    const visit = (node) => {
        if (ts.isIdentifier(node) && node.text === name && node !== binding) {
            const { parent } = node;
            if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
                names.add(parent.name.text);
            } else if (ts.isQualifiedName(parent) && parent.left === node) {
                names.add(parent.right.text);
            } else if (
                !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
                !(ts.isPropertyAssignment(parent) && parent.name === node)
            ) {
                whole.push(node);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { names, whole };
};

const callName = (call) => {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : undefined;
};

// The object literal a mock factory hands back, or undefined when the factory is any other reading.
const factoryObject = (factory) => {
    if (factory === undefined || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
        return undefined;
    }
    let body = factory.body;
    if (ts.isBlock(body)) {
        const returned = body.statements.find(ts.isReturnStatement)?.expression;
        if (body.statements.length !== 1 || returned === undefined) {
            return undefined;
        }
        body = returned;
    }
    while (ts.isParenthesizedExpression(body) || ts.isAsExpression(body) || ts.isSatisfiesExpression(body)) {
        body = body.expression;
    }
    return ts.isObjectLiteralExpression(body) ? body : undefined;
};

const propertyKey = (property) => {
    const { name } = property;
    if (name === undefined) {
        return undefined;
    }
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
};

// The one module every name comes from, null when every one stays on the barrel, undefined when they span modules or
// one is unknown.
const soleModule = (names, modules) => {
    const found = new Set([...names].map((name) => (modules.has(name) ? modules.get(name) : undefined)));
    return found.size === 1 && !found.has(undefined) ? [...found][0] : found.size === 0 ? null : undefined;
};

// Moves a specifier to the one module its names come from, or names the site; a count of what moved goes to `stat`.
const moveTo = (cx, node, literal, names, stat, why) => {
    const module = soleModule(names, cx.modules);
    if (module === undefined) {
        cx.human(node, why);
    } else if (module !== null) {
        cx.stats[stat] += 1;
        cx.replaceSpecifier(literal, module);
    }
};

// The names a dynamic import of the barrel is read for, or undefined when they cannot be read off it.
const dynamicNames = (call) => {
    const awaited = call.parent;
    if (!ts.isAwaitExpression(awaited)) {
        return undefined;
    }
    let reader = awaited.parent;
    while (ts.isParenthesizedExpression(reader)) {
        reader = reader.parent;
    }
    if (ts.isPropertyAccessExpression(reader) && ts.isParenthesizedExpression(awaited.parent)) {
        return [reader.name.text];
    }
    if (!ts.isVariableDeclaration(reader) || !ts.isObjectBindingPattern(reader.name)) {
        return undefined;
    }
    const names = reader.name.elements.map((element) => {
        const named = element.propertyName ?? element.name;
        return element.dotDotDotToken === undefined && ts.isIdentifier(named) ? named.text : undefined;
    });
    return names.every((name) => name !== undefined) ? names : undefined;
};

const dynamicImport = (cx, call, literal) => {
    const names = dynamicNames(call);
    if (names === undefined) {
        cx.human(call, "dynamic import of the barrel whose names cannot be read off it");
        return;
    }
    moveTo(cx, call, literal, names, "dynamic", `dynamic import of ${names.join(", ")}, from more than one module`);
};

// A mock factory's own keys and the namespaces it spreads, or a reason it cannot be read.
const mockFactoryReading = (cx, object) => {
    const keys = [];
    const spreads = [];
    for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
            const { expression } = property;
            spreads.push(ts.isIdentifier(expression) && cx.namespaceImports.has(expression.text) ? expression.text : undefined);
            continue;
        }
        const key = propertyKey(property);
        if (key === undefined) {
            return { why: "mock of the barrel with a computed key" };
        }
        keys.push(key);
    }
    if (spreads.includes(undefined)) {
        return { why: "mock of the barrel spreading something other than the barrel's own namespace import" };
    }
    return { keys, spreads };
};

const mockCall = (cx, call, literal, factory) => {
    const object = factoryObject(factory);
    const reading = object === undefined ? { why: "mock of the barrel with a factory this tool cannot read" } : mockFactoryReading(cx, object);
    if (reading.why !== undefined) {
        cx.human(call, reading.why);
        return;
    }
    if (reading.spreads.length === 0) {
        const why = `mock of the barrel replacing ${reading.keys.length} names from more than one module; split it per module`;
        moveTo(cx, call, literal, reading.keys, "mocks", why);
        return;
    }
    for (const name of reading.spreads) {
        cx.mockedNamespaces.set(name, [...(cx.mockedNamespaces.get(name) ?? []), { call, literal, keys: reading.keys }]);
    }
};

// A generator's template of an import line: rewritten as the line it writes, when it stays one plain literal.
const generatedImport = (cx, literal) => {
    const quote = quoteOf(literal, cx.text);
    const written = cx.rewrite(literal.text);
    if (!written.changed) {
        return;
    }
    const escaped = cx.text.slice(literal.getStart() + 1, literal.end - 1) !== literal.text;
    if (written.humans.length > 0 || escaped || written.text.includes(quote) || written.text.includes("\n")) {
        cx.human(literal, "a string writing an import of the barrel, which cannot be rewritten in place");
        return;
    }
    cx.stats.generated += 1;
    cx.edits.push({ start: literal.getStart(), end: literal.end, text: `${quote}${written.text}${quote}` });
};

const importType = (cx, node) => {
    const { qualifier } = node;
    const name = qualifier === undefined ? undefined : ts.isIdentifier(qualifier) ? qualifier.text : qualifier.left.getText();
    const why = "`import(…)` type of the whole barrel; name the modules it reads";
    if (name === undefined) {
        cx.human(node, why);
        return;
    }
    moveTo(cx, node, node.argument.literal, [name], "dynamic", why);
};

const barrelArgument = (cx, call) => {
    const [first] = call.arguments;
    const specifier = first === undefined ? undefined : literalText(first);
    return specifier !== undefined && cx.isBarrel(specifier) ? first : undefined;
};

// Every expression that names the barrel outside a declaration: `import(…)`, a mock, a template, an import type.
export const visitReferences = (cx, node) => {
    const literal = ts.isCallExpression(node) ? barrelArgument(cx, node) : undefined;
    if (literal !== undefined && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        dynamicImport(cx, node, literal);
    } else if (literal !== undefined && MOCKERS.has(callName(node) ?? "")) {
        mockCall(cx, node, literal, node.arguments[1]);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && WRITTEN_IMPORT.test(node.text)) {
        generatedImport(cx, node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && cx.isBarrel(literalText(node.argument.literal) ?? "")) {
        importType(cx, node);
    }
    ts.forEachChild(node, (child) => visitReferences(cx, child));
};

// `import * as ns` from the barrel: moved whole when everything read off it, a mock factory's keys included, comes
// from one module.
export const moveNamespace = (cx, name, { statement, binding }) => {
    const { names, whole } = namespaceUses(cx.sourceFile, name, binding);
    const mocks = cx.mockedNamespaces.get(name) ?? [];
    const spreadInMock = (node) => mocks.some(({ call }) => node.pos >= call.pos && node.end <= call.end && ts.isSpreadAssignment(node.parent));
    if (whole.some((node) => !spreadInMock(node))) {
        cx.human(statement, `namespace import \`${name}\` of the barrel is used whole; name the modules it reads`);
        return;
    }
    const module = soleModule([...names, ...mocks.flatMap(({ keys }) => keys)], cx.modules);
    if (module === undefined) {
        cx.human(statement, `namespace import \`${name}\` of the barrel reads names from more than one module`);
        return;
    }
    if (module === null) {
        return;
    }
    cx.stats.namespaces += 1;
    cx.replaceSpecifier(statement.moduleSpecifier, module);
    for (const { literal } of mocks) {
        cx.stats.mocks += 1;
        cx.replaceSpecifier(literal, module);
    }
};
