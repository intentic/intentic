import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema, sandboxRouteAllowed } from "@intentic/extension-manifest";
import { SANDBOX_ROUTES } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";

// Conformance: every daemon route a first-party extension calls must be declared in its manifest's permissions.sandbox,
// or apiImpl.ts throws at runtime.
// Typed calls (api.sandbox.rpc.git.stashApply) resolve exactly via the contract's route table; string calls
// (api.sandbox.json(`/git/...`)) are only approximated by scanning source.
// The string scanner stays until every extension is converted to typed calls.

const extensionsRoot = join(repoRoot(import.meta.url), "_extensions");

const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...sourceFiles(full));
        } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".vue")) && !entry.name.endsWith(".test.ts")) {
            out.push(full);
        }
    }
    return out;
};

interface Call {
    readonly method: string;
    readonly path: string;
}

// Balanced argument list starting at the opening `(`, depth-counted so a nested call inside doesn't truncate it.
const callArgs = (text: string, openParen: number): string => {
    let depth = 0;
    for (let i = openParen; i < text.length; i++) {
        if (text[i] === "(") {
            depth++;
        } else if (text[i] === ")" && --depth === 0) {
            return text.slice(openParen + 1, i);
        }
    }
    return text.slice(openParen + 1);
};

// Finds method-producing helpers (`const jsonPost = (...) => ({ method: "POST", ... })`) in the file.
// A call passing jsonPost(...) as its options carries that method though no literal `method:` appears at the call site.
const scanMethodHelpers = (text: string): Map<string, string> => {
    const helpers = new Map<string, string>();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*\(?\{[^}]*?method:\s*[`'"]([A-Za-z]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        helpers.set(match[1] ?? "", match[2] ?? "");
    }
    return helpers;
};

// Route-producing helpers (`const post = (action, ...) => api.sandbox.json('/git/.../${action}', ...)`) are expanded
// over every literal their call sites pass, so a wildcard action segment doesn't force an over-broad manifest grant.
// Only route-segment-shaped literals count; a helper whose first string parameter is prose (a title, a message) is not
// treated as a route.
const ROUTE_SEGMENT = /^[a-z][a-z0-9/-]*$/i;
const scanRouteSegments = (text: string): Map<string, readonly string[]> => {
    const segments = new Map<string, readonly string[]>();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]*>\s*)?\(\s*([A-Za-z_$][\w$]*)\s*:\s*string/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const helper = match[1] ?? "";
        const parameter = match[2] ?? "";
        const literals = [...text.matchAll(new RegExp(`\\b${helper}\\s*\\(\\s*[\`'"]([^\`'"]+)`, "g"))]
            .map((hit) => hit[1] ?? "")
            .filter((literal) => ROUTE_SEGMENT.test(literal));
        if (literals.length > 0) {
            segments.set(parameter, literals);
        }
    }
    return segments;
};

// Expands to one path per resolvable bare-identifier interpolation; a wrapped expression like `${encode(repo.value)}`
// stays a wildcard.
const expandSegments = (raw: string, segments: Map<string, readonly string[]>): readonly string[] => {
    const hit = /\$\{([A-Za-z_$][\w$]*)\}/.exec(raw);
    const literals = hit === null ? undefined : segments.get(hit[1] ?? "");
    if (hit === null || literals === undefined) {
        return [raw];
    }
    return literals.flatMap((literal) => expandSegments(raw.replace(hit[0], literal), segments));
};

// Resolves each typed call (sandbox.rpc.git.stashApply) through the contract's route table for its exact method and
// path, keeping `{param}` braces to match a manifest's glob segment.
// A call to a procedure the contract doesn't declare is reported as an unmatchable route rather than skipped, since the
// host would refuse it at runtime too.
const scanTypedCalls = (text: string): Call[] =>
    [...text.matchAll(/sandbox\.rpc\.(\w+)\.(\w+)\s*\(/g)].map((match) => {
        const name = `${match[1]}.${match[2]}`;
        const route = SANDBOX_ROUTES.find((candidate) => candidate.name === name);
        return route === undefined ? { method: "UNKNOWN", path: `<no contract route named ${name}>` } : { method: route.method, path: route.path };
    });

// Finds SCREAMING_CASE string constants (`const KNOWLEDGE_BASE = "/x/intentic.knowledge"`) so a call that interpolates
// one resolves to a real prefix, not a wildcard.
// Gathered across all files, since the constant and the call site can live in different files.
const scanStringConstants = (texts: readonly string[]): Map<string, string> => {
    const constants = new Map<string, string>();
    for (const text of texts) {
        for (const match of text.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*[`'"]([^`'"$]+)[`'"]/g)) {
            constants.set(match[1] ?? "", match[2] ?? "");
        }
    }
    return constants;
};

// Every api.sandbox.request/json call: path is normalized (constants resolved, query stripped, `${...}` -> `*`); method
// comes from a literal `method:`, else a method helper, else GET.
// A path interpolating a route helper's parameter yields one entry per literal that helper is called with.
const scanCalls = (text: string, helpers: Map<string, string>, segments: Map<string, readonly string[]>, constants: Map<string, string>): Call[] => {
    const calls: Call[] = [];
    const re = /sandbox\.(?:json|request)(?:<[^>]*>)?\(\s*[`'"]([^`'"]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const raw = (match[1] ?? "").replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name: string) => constants.get(name) ?? whole);
        // Anchors on the `(` right before the path's quote, not lastIndexOf: the path may carry its own parens.
        let paren = match[0].length - (match[1] ?? "").length - 2;
        while (paren > 0 && /\s/.test(match[0][paren] ?? "")) {
            paren--;
        }
        const args = callArgs(text, match.index + paren);
        const literal = /method:\s*[`'"]([A-Za-z]+)/.exec(args)?.[1];
        const helper = literal ? undefined : [...helpers].find(([helperName]) => new RegExp(`\\b${helperName}\\s*\\(`).test(args));
        const method = literal ?? helper?.[1] ?? "GET";
        for (const expanded of expandSegments(raw, segments)) {
            calls.push({ method, path: expanded.split("?")[0]?.replace(/\$\{[^}]*\}/g, "*") ?? "" });
        }
    }
    return calls;
};

// api.models is a live read across every connected provider (credentials held, plan headroom, last refusal); extensions
// must use it rather than the raw /{provider}/models and /{provider}/accounts routes.
// Fails on the manifest declaration as well as the call, since a granted-just-in-case permission is what makes the raw
// call reachable at all.
const CATALOG_ROUTE = /^\/[^/]+\/(models|accounts)$/;
const everyExtension = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, "intentic-extension.json")))
    .map((entry) => entry.name);

// Every sandbox call an extension's source makes; a data-only pack (manifest, no src/) makes none.
const callsOf = (name: string): Call[] => {
    const dir = join(extensionsRoot, name, "src");
    if (!existsSync(dir)) {
        return [];
    }
    const texts = sourceFiles(dir).map((file) => readFileSync(file, "utf8"));
    const constants = scanStringConstants(texts);
    return texts.flatMap((text) => scanTypedCalls(text).concat(scanCalls(text, scanMethodHelpers(text), scanRouteSegments(text), constants)));
};

// Calls into an extension's own /x/publisher.name/ namespace are exempt from declaration, mirroring apiImpl.ts: it's
// the extension's own backend, not a grant.
// Only the exact namespace is exempt; a call into another extension's namespace conforms like any core route.
const ownNamespaceOf = (name: string): string => {
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(extensionsRoot, name, "intentic-extension.json"), "utf8")));
    return `/x/${manifest.publisher}.${manifest.name}/`;
};
const declarableCallsOf = (name: string): Call[] => {
    const own = ownNamespaceOf(name);
    return callsOf(name).filter((call) => !call.path.startsWith(own));
};

describe.each(everyExtension)("%s reads models and accounts through api.models, not the daemon", (name) => {
    const root = join(extensionsRoot, name);
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(root, "intentic-extension.json"), "utf8")));

    test("declares no model or account catalog route", () => {
        const declared = (manifest.permissions?.sandbox ?? []).filter((route) => CATALOG_ROUTE.test(route.replace(/^[A-Z]+\s+/, "")));
        expect(declared).toEqual([]);
    });

    test("calls no model or account catalog route", () => {
        expect(callsOf(name).filter((call) => CATALOG_ROUTE.test(call.path))).toEqual([]);
    });
});

// Every extension in the directory, derived rather than hand-kept: a fixed list silently drops extensions added later,
// along with routes they call but never declared.
const sandboxPermissionsOf = (name: string): readonly string[] => {
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(extensionsRoot, name, "intentic-extension.json"), "utf8")));
    return manifest.permissions?.sandbox ?? [];
};

// Extensions that make an api.sandbox call; some packs make none, so this filters rather than asserts over all.
const callers = everyExtension.filter((name) => callsOf(name).length > 0);

// The scanner is regex over source; a silent failure to match would make every check below vacuously pass.
// An extension that declares sandbox routes must have calls the scanner finds; if this fails, suspect the regexes
// before the manifest.
test("the scanner finds calls in every extension that declares sandbox routes", () => {
    const declaring = everyExtension.filter((name) => sandboxPermissionsOf(name).length > 0);
    expect(declaring.filter((name) => !callers.includes(name))).toEqual([]);
});

// Callers with a call outside their own namespace; an empty test.each would be a vitest error, not a pass.
const declaringCallers = callers.filter((name) => declarableCallsOf(name).length > 0);

describe.each(declaringCallers)("%s declares every sandbox route it calls", (name) => {
    const permissions = sandboxPermissionsOf(name);
    test.each(declarableCallsOf(name).map((call) => [`${call.method} ${call.path}`, call] as const))("declares %s", (_label, call) => {
        expect(sandboxRouteAllowed(permissions, call.method, call.path)).toBe(true);
    });
});
