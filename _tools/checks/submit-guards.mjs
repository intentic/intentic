#!/usr/bin/env node
// An Enter key bound to an async handler that writes something, with nothing stopping the second press while the first
// is still in flight. The button beside it is usually `:disabled`/`:loading` and so is safe; the keyboard path reaches
// the handler directly, and that is the path an impatient user takes. Measured shape, not a style preference: a held
// Enter on one such dialog fired five extension creations.
//
// Guarded is decided by structure, not by what a flag is called: before its first `await`, the handler must test
// something in an early return that it then also sets (or clears), or hand the work to a function that does. Naming the
// flags instead would pass `saveError` as a guard and fail `replying`. The handler is judged where its body lives, often
// a composable the component only wires up; a handler whose body cannot be found is a finding, never a pass.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { finish } from "./lib/report.mjs";
import { byName, installedModule, packages, root, VUE_FILE, walk, workspaceSource } from "./lib/repo.mjs";

const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const compiler = vueHost === undefined ? undefined : installedModule(vueHost.dir, "vue/compiler-sfc");

/* GUARDS: read off a function's text, in the module its body was found in. */

// `const spec = creating.value` makes `spec` stand for `creating`: the early return tests the alias and the body clears
// the ref, and those have to be recognised as the same latch.
const aliases = (head) => {
    const map = new Map();
    for (const [, local, source] of head.matchAll(/\bconst\s+([a-zA-Z_$][\w$]*)\s*=\s*([a-zA-Z_$][\w$]*)(?:\.value)?/g)) {
        map.set(local, source);
    }
    return map;
};
const named = (text, map) => new Set([...text.matchAll(/([a-zA-Z_$][\w$]*)/g)].map(([, name]) => map.get(name) ?? name));

// True when the head refuses on something it then also latches: the one shape that actually stops a second press.
const latchesWhatItTests = (head) => {
    const map = aliases(head);
    const tested = new Set();
    for (const [, condition] of head.matchAll(/\bif\s*\(([\s\S]*?)\)\s*\{?\s*(?:\n\s*)?return\b/g)) {
        for (const identifier of named(condition, map)) {
            tested.add(identifier);
        }
    }
    const latched = new Set();
    for (const [, target] of head.matchAll(/([a-zA-Z_$][\w$]*)(?:\.value)?\s*=\s*(?!=)/g)) {
        latched.add(map.get(target) ?? target);
    }
    for (const [, target] of head.matchAll(/([a-zA-Z_$][\w$]*)\.(?:add|set|delete)\s*\(/g)) {
        latched.add(map.get(target) ?? target);
    }
    return [...tested].some((identifier) => latched.has(identifier));
};

// Whether a function drops a second call; `seen` stops a cycle. Delegation is decided by what each callee resolves to,
// so `useAsyncAction`'s `run` passes because its own body latches, and a `run` that does not latch fails.
const guards = (fn, seen = new Set()) => {
    if (seen.has(fn.node)) {
        return false;
    }
    seen.add(fn.node);
    const body = textOf(fn);
    const firstAwait = body.indexOf("await");
    return latchesWhatItTests(firstAwait === -1 ? body : body.slice(0, firstAwait)) || delegatesToAGuard(fn, seen);
};

// Every call counts, nested callbacks included: work handed to `run(async () => …)` is still handed.
const delegatesToAGuard = (fn, seen) =>
    calleesIn(fn.node).some((callee) => {
        const target = valueOf(fn.module, callee, 0);
        return isFunction(target) && guards(target, seen);
    });

/* RESOLUTION: a name to the function it holds, through declarations, destructuring, returned objects and imports. */

// A value that leaves this repository's modules, so there is no body here to judge: a global, a compiler macro
// (`defineProps`/`defineEmits`: the parent's handler), a name the script never declares (a prop, a `v-for`/slot alias,
// `$emit`), or a package outside the workspace.
const ELSEWHERE = Symbol("elsewhere");
// Steps one resolution may take; running out is what ends a cycle, such as two modules re-exporting each other.
const STEPS = 48;
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ObjectMethod", "ClassMethod"]);
// The nodes a binding is visible inside; a reference means the innermost one declaring its name.
const SCOPES = new Set(["Program", "BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", ...FUNCTIONS]);
// Type-level wrappers, which hand their `expression` through unchanged.
const TYPED = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression"]);
const MEMBER = new Set(["MemberExpression", "OptionalMemberExpression"]);
const CALL = new Set(["CallExpression", "OptionalCallExpression"]);

const isNode = (value) => typeof value?.type === "string";
const childrenOf = (node) => Object.values(node).flatMap((value) => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []));
const keyName = (key) => (key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : undefined);
const isFunction = (value) => FUNCTIONS.has(value?.node?.type);
const textOf = ({ module, node }) => module.source.slice(node.start, node.end);
const calleesIn = (node) => childrenOf(node).flatMap((child) => [...(CALL.has(child.type) ? [child.callee] : []), ...calleesIn(child)]);

const parsed = (source) => {
    try {
        return compiler.babelParse(source, { sourceType: "module", plugins: ["typescript"], errorRecovery: true }).program;
    } catch {
        return undefined;
    }
};

// The names a pattern binds, each with the keys a destructure reads to reach it. An `undefined` key (computed, rest, or
// an array slot) is one no literal can answer, so that name resolves to nothing.
const namesIn = (pattern, keys = []) => {
    switch (pattern.type) {
        case "Identifier":
            return [[pattern.name, keys]];
        case "ObjectPattern":
            return pattern.properties.flatMap((property) =>
                property.type === "RestElement"
                    ? namesIn(property.argument, [...keys, undefined])
                    : namesIn(property.value, [...keys, property.computed ? undefined : keyName(property.key)]),
            );
        case "AssignmentPattern":
            return namesIn(pattern.left, keys);
        case "ArrayPattern":
            return pattern.elements.filter(isNode).flatMap((element) => namesIn(element, [...keys, undefined]));
        case "RestElement":
            return namesIn(pattern.argument, [...keys, undefined]);
        case "TSParameterProperty":
            return namesIn(pattern.parameter, keys);
        default:
            return [];
    }
};
const importedName = (specifier) =>
    specifier.type === "ImportSpecifier" ? keyName(specifier.imported) : specifier.type === "ImportDefaultSpecifier" ? "default" : "*";
// The names one node declares: an import's, a function's own (in the scope around it), a declarator's, its parameters.
// A parameter holds no initializer, so it resolves to nothing rather than to a same-named binding further out.
const declaredBy = (node, scope, program) => [
    ...(node.type === "ImportDeclaration" && node.importKind !== "type" ? node.specifiers : [])
        .filter((specifier) => specifier.importKind !== "type")
        .map((specifier) => [specifier.local.name, { scope: program, from: node.source.value, imported: importedName(specifier) }]),
    ...(node.type === "FunctionDeclaration" && node.id !== null ? [[node.id.name, { scope, node }]] : []),
    ...(node.type === "VariableDeclarator" ? namesIn(node.id) : []).map(([name, keys]) => [name, { scope, keys, init: keys.includes(undefined) ? undefined : node.init }]),
    ...(FUNCTIONS.has(node.type) ? node.params.flatMap((param) => namesIn(param)) : []).map(([name]) => [name, { scope: node, keys: [] }]),
];
// Every name a module binds, with the node it is visible inside.
const bindingsOf = (program) => {
    const bindings = new Map();
    const visit = (node, scope) => {
        for (const [name, binding] of declaredBy(node, scope, program)) {
            bindings.set(name, [...(bindings.get(name) ?? []), binding]);
        }
        for (const child of childrenOf(node)) {
            visit(child, SCOPES.has(node.type) ? node : scope);
        }
    };
    visit(program, program);
    return bindings;
};

// The names one top-level statement exports, each as a local, a re-export, or (the default) an expression.
const exportedBy = (statement) => {
    if (statement.type === "ExportDefaultDeclaration") {
        return [["default", { node: statement.declaration }]];
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") {
        return [];
    }
    const { declaration, source, specifiers } = statement;
    const locals = [...(declaration?.declarations ?? []).map(({ id }) => id), declaration?.id].filter((id) => id?.type === "Identifier");
    const reexports = specifiers.map((specifier) => [keyName(specifier.exported), specifier.type === "ExportNamespaceSpecifier" ? "*" : keyName(specifier.local)]);
    return [
        ...locals.map(({ name }) => [name, { local: name }]),
        ...reexports.map(([name, imported]) => [name, source === null ? { local: imported } : { from: source.value, imported }]),
    ];
};
// What a module exports by name, and the modules its `export *` lines read.
const exportsOf = (program) => ({
    exported: new Map(program.body.flatMap(exportedBy)),
    stars: program.body.filter(({ type, exportKind }) => type === "ExportAllDeclaration" && exportKind !== "type").map(({ source }) => source.value),
});

// A file as the resolver reads it; a `.vue` file is its two script blocks read as one. Undefined for a file that is not
// there or that babel cannot read, which resolves nothing.
const modules = new Map();
const moduleAt = (file) => {
    if (!modules.has(file)) {
        modules.set(file, readModule(file));
    }
    return modules.get(file);
};
const readModule = (file) => {
    if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
        return undefined;
    }
    const text = readFileSync(file, "utf8");
    const { descriptor } = VUE_FILE.test(file) ? compiler.parse(text, { filename: file }) : {};
    const source = descriptor === undefined ? text : [descriptor.script, descriptor.scriptSetup].flatMap((block) => (block === null ? [] : [block.content])).join("\n");
    const program = parsed(source);
    return program === undefined ? undefined : { file, source, program, bindings: bindingsOf(program), ...exportsOf(program) };
};

// A specifier to the file holding its source, the way the repo's other resolvers read one (sandboxScope.guard.test.ts):
// a relative `.js` is the `.ts` beside it, and an extensionless one is a `.ts` or `.vue` file before a directory's index.
const fileOf = (from, specifier) => {
    if (!specifier.startsWith(".")) {
        return packageSource(specifier);
    }
    const base = resolve(dirname(from), specifier);
    return [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, `${base}.vue`, join(base, "index.ts")].find(
        (candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true,
    );
};
// A workspace package's source: `@intentic/src` where the package ships a dist (lib/repo.mjs), else the file its export
// map names, since a package that ships its source names it directly. Any other bare specifier is ELSEWHERE.
const packageSource = (specifier) => {
    const depth = specifier.startsWith("@") ? 2 : 1;
    const segments = specifier.split("/");
    const owner = byName.get(segments.slice(0, depth).join("/"));
    if (owner === undefined) {
        return ELSEWHERE;
    }
    const entry = owner.pkg.exports?.[segments.length > depth ? `./${segments.slice(depth).join("/")}` : "."];
    const shipped = typeof entry === "string" ? entry : entry?.default;
    return workspaceSource(specifier) ?? (typeof shipped === "string" ? join(owner.dir, shipped) : undefined);
};

// A call holds what its callee returns. A library's `reactive({ … })` and its kind hand back the literal they wrap, so
// that literal is read instead; a member it lacks is the library's.
const callValue = (module, node, steps) => {
    const callee = valueOf(module, node.callee, steps);
    if (callee === ELSEWHERE) {
        const [wrapped] = node.arguments;
        return wrapped?.type === "ObjectExpression" ? { module, node: wrapped, lent: true } : ELSEWHERE;
    }
    return isFunction(callee) && node.type !== "NewExpression" ? returnOf(callee, steps) : undefined;
};
// `a.b` by name only: `a[key]` and `a.#b` name no member a literal could be read for.
const memberName = (node) => (node.computed || node.property.type !== "Identifier" ? undefined : node.property.name);
const memberValue = (module, node, steps) => {
    const name = memberName(node);
    return name === undefined ? undefined : memberOf(valueOf(module, node.object, steps), [name], steps);
};
const FOLLOW = {
    Identifier: (module, node, steps) => valueOfName(module, node.name, node.start, steps),
    AwaitExpression: (module, node, steps) => valueOf(module, node.argument, steps),
    ...Object.fromEntries([...TYPED].map((type) => [type, (module, node, steps) => valueOf(module, node.expression, steps)])),
    ...Object.fromEntries([...MEMBER].map((type) => [type, memberValue])),
    ...Object.fromEntries([...CALL, "NewExpression"].map((type) => [type, callValue])),
};
// What an expression holds, as `{ module, node }`: a function, an object literal, or a value with nothing left to
// follow. ELSEWHERE carries through; undefined means the trail went cold inside this repository.
const valueOf = (module, node, steps) => {
    if (steps > STEPS) {
        return undefined;
    }
    const follow = FOLLOW[node.type];
    return follow === undefined ? { module, node } : follow(module, node, steps + 1);
};

// A name at `at` (undefined: the top level, which is all a template sees) to the value its binding holds.
const valueOfName = (module, name, at, steps) => {
    const binding = (module.bindings.get(name) ?? [])
        .filter(({ scope }) => (at === undefined ? scope === module.program : scope.start <= at && at < scope.end))
        .reduce((inner, one) => (inner === undefined || one.scope.end - one.scope.start < inner.scope.end - inner.scope.start ? one : inner), undefined);
    if (binding === undefined) {
        return ELSEWHERE;
    }
    if (binding.from !== undefined) {
        return importedValue(module.file, binding.from, binding.imported, steps);
    }
    if (binding.node !== undefined) {
        return { module, node: binding.node };
    }
    return isNode(binding.init) ? memberOf(valueOf(module, binding.init, steps), binding.keys, steps) : undefined;
};

const importedValue = (from, specifier, name, steps) => {
    const file = fileOf(from, specifier);
    return file === ELSEWHERE ? ELSEWHERE : exportedValue(file, name, steps + 1);
};
const exportedValue = (file, name, steps) => {
    const module = file === undefined ? undefined : moduleAt(file);
    if (module === undefined || steps > STEPS) {
        return undefined;
    }
    if (name === "*") {
        return { module, namespace: true };
    }
    const entry = module.exported.get(name);
    if (entry === undefined) {
        for (const star of module.stars) {
            const value = importedValue(file, star, name, steps);
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }
    if (entry.from !== undefined) {
        return importedValue(file, entry.from, entry.imported, steps);
    }
    return entry.local === undefined ? valueOf(module, entry.node, steps + 1) : valueOfName(module, entry.local, undefined, steps + 1);
};

// Reads `keys` off a value one at a time: a namespace's export, or an object literal's property, method or spread.
const memberOf = (value, keys, steps) => {
    let held = value;
    for (const key of keys) {
        if (held === undefined || held === ELSEWHERE) {
            return held;
        }
        held = held.namespace === true ? exportedValue(held.module.file, key, steps + 1) : propertyOf(held, key, steps + 1);
    }
    return held;
};
const propertyOf = ({ module, node, lent }, key, steps) => {
    if (node.type !== "ObjectExpression") {
        return undefined;
    }
    let fallback = lent === true ? ELSEWHERE : undefined;
    // Last one wins, as it does in the object itself.
    for (const property of node.properties.toReversed()) {
        if (property.type === "SpreadElement") {
            const spread = memberOf(valueOf(module, property.argument, steps), [key], steps);
            if (spread === ELSEWHERE) {
                fallback = ELSEWHERE;
            } else if (spread !== undefined) {
                return spread;
            }
        } else if (!property.computed && keyName(property.key) === key) {
            return property.type === "ObjectMethod" ? { module, node: property } : valueOf(module, property.value, steps);
        }
    }
    return fallback;
};

// What a function hands back: its expression body, else its own last `return` (a nested function's does not count).
const returnOf = ({ module, node }, steps) => {
    if (node.body.type !== "BlockStatement") {
        return valueOf(module, node.body, steps);
    }
    const returned = returnsIn(node.body).at(-1);
    return returned === undefined ? undefined : valueOf(module, returned, steps);
};
const returnsIn = (node) =>
    childrenOf(node).flatMap((child) =>
        child.type === "ReturnStatement" ? [child.argument].filter(isNode) : FUNCTIONS.has(child.type) ? [] : returnsIn(child),
    );

/* THE TEMPLATE: which handlers Enter runs. */

// Every expression bound to Enter on a key event, whatever the other modifiers are and in whatever order.
const enterBindings = (node) => [
    ...(node.props ?? []).flatMap((prop) =>
        prop.name === "on" && /^key(?:down|up|press)$/.test(prop.arg?.content ?? "") && prop.modifiers.some(({ content }) => content === "enter") && prop.exp !== undefined
            ? [prop.exp.content]
            : [],
    ),
    ...(node.children ?? []).flatMap(enterBindings),
];

// `edit.commit` as ["edit", "commit"]; undefined for a callee no name reaches, such as `handlers[key]`.
const pathOf = (node) => {
    if (node.type === "Identifier") {
        return [node.name];
    }
    if (TYPED.has(node.type)) {
        return pathOf(node.expression);
    }
    const name = MEMBER.has(node.type) ? memberName(node) : undefined;
    const object = name === undefined ? undefined : pathOf(node.object);
    return object === undefined ? undefined : [...object, name];
};
// A call a binding makes, but not one that only computes an argument: `x && submit(draft.trim())` runs `submit`.
const runsIn = (node) => (CALL.has(node.type) ? [pathOf(node.callee)] : childrenOf(node).flatMap(runsIn));
// What one binding runs, as name paths: the method it names (`submit`, `edit.commit`), else each call it makes.
const handlersOf = (expression) => {
    const program = parsed(expression);
    if (program === undefined) {
        return [undefined];
    }
    const [statement] = program.body;
    const method = program.body.length === 1 && statement.type === "ExpressionStatement" ? pathOf(statement.expression) : undefined;
    return method === undefined ? runsIn(program) : [method];
};

const unguarded = [];
const unresolved = [];
const checked = [];
let handedIn = 0;
if (compiler !== undefined) {
    for (const file of walk(root, VUE_FILE)) {
        const relative = file.slice(root.length + 1);
        const { descriptor, errors } = compiler.parse(readFileSync(file, "utf8"), { filename: file });
        // An unparseable template is vue-templates.mjs's complaint, not this one's.
        if (errors.length > 0 || descriptor.template === null) {
            continue;
        }
        const handlers = new Map(
            enterBindings(descriptor.template.ast).flatMap((expression) => handlersOf(expression).map((path) => [path?.join(".") ?? expression, path])),
        );
        for (const [handler, path] of handlers) {
            const module = moduleAt(file);
            const value = path === undefined || module === undefined ? undefined : memberOf(valueOfName(module, path[0], undefined, 0), path.slice(1), 0);
            if (value === ELSEWHERE) {
                handedIn += 1;
                continue;
            }
            if (!isFunction(value)) {
                unresolved.push(`${relative}: \`${handler}\` is bound to Enter, and this check could not find its body`);
                continue;
            }
            // A handler that never awaits finishes before the second press can arrive.
            if (!/\bawait\b/.test(textOf(value))) {
                continue;
            }
            checked.push(`${relative}:${handler}`);
            if (!guards(value)) {
                const home = value.module.file === file ? "" : ` (its body is in ${value.module.file.slice(root.length + 1)})`;
                unguarded.push(`${relative}: \`${handler}\`${home} is bound to Enter, awaits, and nothing drops the second press`);
            }
        }
    }
}

finish(
    [
        [
            "An Enter-bound handler can run again while its own write is still in flight (test an in-flight flag in an early return and set it before awaiting, or route the work through useAsyncAction)",
            unguarded,
        ],
        [
            "An Enter-bound handler this check could not follow to its body, so nothing vouches for it (teach submit-guards.mjs's resolver the shape that hides it)",
            unresolved,
        ],
    ],
    [
        compiler === undefined
            ? `submit guards: not read (vue/compiler-sfc needs node_modules, and this ran before the install)`
            : `submit guards: all ${checked.length} Enter-bound async handlers drop a second press (not judged: ${handedIn} that call an emit, a prop or a library)`,
    ],
);
