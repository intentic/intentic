import type { ESTree, Options, Scope, SourceCode, Variable } from "@oxlint/plugins";

/** Every node oxlint tags `Identifier`; the six flavours are separate interfaces and only the tag is shared. */
export type IdentifierNode = Extract<ESTree.Node, { type: "Identifier" }>;

/** A callback a rule can look inside. A callback passed by name is a reference, and its body is somewhere else. */
export type FunctionLiteral = ESTree.ArrowFunctionExpression | ESTree.Function;

/** A callee flattened to the identifier it starts from and the properties applied to it. */
export type CalleeChain = { readonly root: IdentifierNode; readonly members: readonly IdentifierNode[] };

/** A bun:test call, named by the export it starts from rather than by the identifier it was bound to. */
export type BunTestCall = { readonly kind: "describe" | "test" | "hook"; readonly modifiers: readonly IdentifierNode[] };

/** A title a suite or test can be compared on, and the node a diagnostic about it points at. */
export type TestTitle = { readonly text: string; readonly node: ESTree.Node };

/** The `resolves`, `not`, `toThrow` of an assertion, and the first and last of them in the source. */
export type MatcherChain = { readonly names: readonly string[]; readonly first: IdentifierNode; readonly last: IdentifierNode };

const TEST_EXPORTS = new Set(["it", "test"]);
const HOOK_EXPORTS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);

function resolveVariable(sourceCode: SourceCode, identifier: IdentifierNode): Variable | null {
    let scope: Scope | null = sourceCode.getScope(identifier);
    while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
            return variable;
        }
        scope = scope.upper;
    }
    return null;
}

function importedName(node: ESTree.Node): string | null {
    if (node.type !== "ImportSpecifier") {
        return null;
    }
    return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

/** The "bun:test" export an identifier binds to, or null. Nothing here fires on a local binding that merely shares a name. */
export function bunTestExport(sourceCode: SourceCode, identifier: IdentifierNode): string | null {
    const variable = resolveVariable(sourceCode, identifier);
    if (variable === null) {
        return null;
    }
    for (const definition of variable.defs) {
        if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
            continue;
        }
        if (definition.parent.source.value !== "bun:test") {
            continue;
        }
        const name = importedName(definition.node);
        if (name !== null) {
            return name;
        }
    }
    return null;
}

function flatten(expression: ESTree.Node, members: IdentifierNode[]): CalleeChain | null {
    if (expression.type === "CallExpression") {
        return flatten(expression.callee, members);
    }
    if (expression.type === "TaggedTemplateExpression") {
        return flatten(expression.tag, members);
    }
    if (expression.type === "MemberExpression") {
        if (expression.computed) {
            return null;
        }
        const property = expression.property;
        if (property.type !== "Identifier") {
            return null;
        }
        members.unshift(property);
        return flatten(expression.object, members);
    }
    if (expression.type === "Identifier") {
        return { root: expression, members };
    }
    return null;
}

/** Flattens `it.only.each(rows)` to `it` plus `only`, `each` — the factory call in the middle carries no meaning of its own. */
export function calleeChain(expression: ESTree.Node): CalleeChain | null {
    return flatten(expression, []);
}

function isApplied(node: ESTree.CallExpression): boolean {
    const parent = node.parent;
    if (parent.type === "CallExpression") {
        return parent.callee === node;
    }
    if (parent.type === "TaggedTemplateExpression") {
        return parent.tag === node;
    }
    return false;
}

/** The bun:test call a node is, or null. The `.each(rows)` half of `test.each(rows)(title, fn)` is the factory, not the test. */
export function bunTestCall(sourceCode: SourceCode, node: ESTree.CallExpression): BunTestCall | null {
    if (isApplied(node)) {
        return null;
    }
    const chain = calleeChain(node.callee);
    if (chain === null) {
        return null;
    }
    const exported = bunTestExport(sourceCode, chain.root);
    if (exported === null) {
        return null;
    }
    if (exported === "describe") {
        return { kind: "describe", modifiers: chain.members };
    }
    if (TEST_EXPORTS.has(exported)) {
        return { kind: "test", modifiers: chain.members };
    }
    if (HOOK_EXPORTS.has(exported)) {
        return { kind: "hook", modifiers: chain.members };
    }
    return null;
}

/** Whether a file imports the module at all — no rule here can fire in one that does not, and most files do not. */
export function importsBunTest(program: ESTree.Program): boolean {
    return program.body.some((statement) => statement.type === "ImportDeclaration" && statement.source.value === "bun:test");
}

/** The modifier of that name applied to a call, or undefined. Returns the node so a diagnostic can point at the word. */
export function modifier(call: BunTestCall, name: string): IdentifierNode | undefined {
    return call.modifiers.find((member) => member.name === name);
}

/** The `expect(…)` or `expect.soft(…)` a matcher chain hangs off. `expect.any(…)` and `expect(x).toBe` are not one. */
export function isExpectCall(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
    const chain = calleeChain(node.callee);
    if (chain === null || chain.members.length > 1) {
        return false;
    }
    const soft = chain.members[0];
    if (soft !== undefined && soft.name !== "soft") {
        return false;
    }
    return bunTestExport(sourceCode, chain.root) === "expect";
}

/** A function literal, which is the only callback whose body is in reach of the AST at this call site. */
export function isFunctionLiteral(node: ESTree.Node): node is FunctionLiteral {
    return node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration";
}

/** The first function literal passed to a call — bun accepts an options object between the title and the body. */
export function callbackArgument(node: ESTree.CallExpression): FunctionLiteral | null {
    for (const argument of node.arguments) {
        if (isFunctionLiteral(argument)) {
            return argument;
        }
    }
    return null;
}

function isStringLiteral(node: ESTree.Node): node is ESTree.StringLiteral {
    return node.type === "Literal" && typeof node.value === "string";
}

/** The title a describe/test call was given, or null when it is not a literal two call sites can be compared on. */
export function literalTitle(node: ESTree.CallExpression): TestTitle | null {
    const title = node.arguments[0];
    if (title === undefined) {
        return null;
    }
    if (isStringLiteral(title)) {
        return { text: title.value, node: title };
    }
    if (title.type !== "TemplateLiteral" || title.expressions.length > 0) {
        return null;
    }
    const text = title.quasis[0]?.value.cooked;
    return text === undefined || text === null ? null : { text, node: title };
}

/** A rule's options arrive as plain JSON, so the shape a rule declared in `meta.schema` still has to be recovered here. */
export function isOptionRecord(option: Options[number]): option is Record<string, Options[number]> {
    return typeof option === "object" && option !== null && !Array.isArray(option);
}

/** An option value the config gave as a string. */
export function isOptionString(option: Options[number]): option is string {
    return typeof option === "string";
}

/** The modifiers and matcher a chain applies after `expect(…)`, with the nodes that bound the chain in the source. */
export function matcherChain(expectCall: ESTree.CallExpression): MatcherChain | null {
    const names: string[] = [];
    let first: IdentifierNode | null = null;
    let last: IdentifierNode | null = null;
    let current: ESTree.Node = expectCall;
    let parent: ESTree.Node = current.parent;
    while (parent.type === "MemberExpression" && !parent.computed && parent.object === current) {
        const property = parent.property;
        if (property.type !== "Identifier") {
            break;
        }
        names.push(property.name);
        first ??= property;
        last = property;
        current = parent;
        parent = current.parent;
    }
    return first === null || last === null ? null : { names, first, last };
}

/** The describe/test callback a node sits inside, or the Program when it sits at the top level. */
export function titleScope(sourceCode: SourceCode, node: ESTree.Node): ESTree.Node {
    let current: ESTree.Node | null = node.parent;
    while (current !== null) {
        if (current.type === "Program") {
            return current;
        }
        if (isFunctionLiteral(current) && current.parent.type === "CallExpression" && current.parent.arguments.includes(current)) {
            const call = bunTestCall(sourceCode, current.parent);
            if (call !== null && call.kind !== "hook") {
                return current;
            }
        }
        current = current.parent;
    }
    return node;
}
