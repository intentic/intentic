import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema, sandboxRouteAllowed } from "@intentic/extension-manifest";
import { SANDBOX_ROUTES } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";

/* Conformance: every daemon route a first-party extension calls must be declared in its manifest's
 * permissions.sandbox — otherwise the host (apiImpl.ts) would throw at runtime. This scans each first-party
 * extension's source and fails if a call isn't covered, so a newly-added route can't ship undeclared.
 *
 * THERE ARE TWO DOORS, and the difference between scanning them is the whole argument for the typed one.
 *
 * `api.sandbox.rpc.git.stashApply(...)` names its route as a SYMBOL. Recovering what it calls is a lookup in the
 * contract's own route table: exact, and incapable of being wrong about the method or the path.
 *
 * `api.sandbox.json(\`/git/${repo}/${action}\`, jsonPost(...))` hides the same fact inside a formatted string, so
 * recovering it means re-implementing a slice of the language — resolving helpers that produce methods, helpers
 * that produce path segments, and interpolations that resolve to neither. That is what the machinery below the
 * typed scan is, and it is worth reading once as the cost of a string-shaped API: it can only ever approximate,
 * and when it silently stopped matching, this file reported 97 passes while three extensions were dead.
 *
 * The string scanner stays until the last extension is converted, and shrinks with each one that is. */

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

// The balanced argument list of a call, starting at its opening `(` — depth-counted so nested calls in the
// options object (JSON.stringify(...), a helper call) don't truncate it. Scopes method detection to exactly one
// call's args instead of a fixed-size window that could bleed into the next call.
const callArgs = (text: string, openParen: number): string => {
    let depth = 0;
    for (let i = openParen; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) return text.slice(openParen + 1, i);
    }
    return text.slice(openParen + 1);
};

// Method-producing request helpers defined in the file: `const jsonPost = (...) => ({ method: "POST", ... })`.
// A call site that passes `jsonPost(...)` as its options carries that method even though no literal `method:`
// appears at the call — resolve it here rather than defaulting to GET.
const scanMethodHelpers = (text: string): Map<string, string> => {
    const helpers = new Map<string, string>();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*\(?\{[^}]*?method:\s*[`'"]([A-Za-z]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        helpers.set(match[1] ?? "", match[2] ?? "");
    }
    return helpers;
};

/* Route-producing helpers defined in the file: `const post = (action: string, …) =>
 * api.sandbox.json(`/git/${encode(repo.value)}/${action}`, …)`, called as post(`checkout`, …).
 *
 * Without this both segments normalize to wildcards and NO precise declaration could ever match the call, so
 * the only way to pass would be a manifest that wildcards the action — exactly the over-broad grant this file
 * argues against. Resolved the same way methods are: find the helper whose FIRST parameter is the interpolated
 * identifier and expand the call over every literal its call sites pass, so what gets checked is the declared
 * "POST /git/<repo>/checkout" rather than a wildcard that hides which write action ran.
 *
 * Only route-segment-shaped literals count — a helper whose first string parameter is prose (a title, a
 * message) is not a route and must not be expanded into one. */
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

// One raw path per resolvable combination of its bare-identifier interpolations. `${encode(repo.value)}` is not
// a bare identifier and stays a wildcard — the repo name is genuinely one segment of anything.
const expandSegments = (raw: string, segments: Map<string, readonly string[]>): readonly string[] => {
    const hit = /\$\{([A-Za-z_$][\w$]*)\}/.exec(raw);
    const literals = hit === null ? undefined : segments.get(hit[1] ?? "");
    if (hit === null || literals === undefined) {
        return [raw];
    }
    return literals.flatMap((literal) => expandSegments(raw.replace(hit[0], literal), segments));
};

/* Every TYPED call in a source file, resolved through the contract's own route table.
 *
 * The whole scan is these four lines, and there is nothing approximate left in it: `sandbox.rpc.git.stashApply`
 * is the contract's name for a route, so the method and path come back from the table rather than from a guess
 * about what a template literal would have formatted to. The path keeps its `{param}` braces — a manifest's
 * glob segment matches them, which is right, because a typed caller cannot choose which repo the route is for
 * any more than a string caller could.
 *
 * A procedure the contract does not declare is reported as an unmatchable route rather than skipped: the host
 * refuses that call at runtime, so a test that ignored it would pass on a feature that cannot work. */
const scanTypedCalls = (text: string): Call[] =>
    [...text.matchAll(/sandbox\.rpc\.(\w+)\.(\w+)\s*\(/g)].map((match) => {
        const name = `${match[1]}.${match[2]}`;
        const route = SANDBOX_ROUTES.find((candidate) => candidate.name === name);
        return route === undefined ? { method: "UNKNOWN", path: `<no contract route named ${name}>` } : { method: route.method, path: route.path };
    });

/* SCREAMING_CASE string constants defined anywhere in the extension's src — `const MEMORY_BASE =
 * "/x/intentic.memory"`. An extension calling its OWN backend interpolates its namespace prefix from one
 * (contract.ts keeps it a literal for exactly this scanner), and resolving it is what lets the own-namespace
 * exemption below match on the real prefix instead of a wildcard that would excuse anything. Gathered across
 * files, unlike the per-file helpers: the constant lives in the contract module, the calls in the data layer. */
const scanStringConstants = (texts: readonly string[]): Map<string, string> => {
    const constants = new Map<string, string>();
    for (const text of texts) {
        for (const match of text.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*[`'"]([^`'"$]+)[`'"]/g)) {
            constants.set(match[1] ?? "", match[2] ?? "");
        }
    }
    return constants;
};

// Every api.sandbox.request/json (or host().sandbox.*) call in a source file: its first string/template-literal
// path arg (normalized — known constants resolved, query stripped, remaining `${…}` → `*`) and its method — a
// literal `method:` in the options object, else a method-producing helper passed as the options, else GET. A
// call whose path interpolates a route helper's parameter yields one entry per literal that helper is called with.
const scanCalls = (text: string, helpers: Map<string, string>, segments: Map<string, readonly string[]>, constants: Map<string, string>): Call[] => {
    const calls: Call[] = [];
    const re = /sandbox\.(?:json|request)(?:<[^>]*>)?\(\s*[`'"]([^`'"]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const raw = (match[1] ?? "").replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name: string) => constants.get(name) ?? whole);
        // The call's opening `(` sits just before the path's quote (regex allows only `\s*` between them). Anchor
        // there rather than lastIndexOf("(") — a path like `/x/${encodeURIComponent(id)}` carries its own parens.
        let paren = match[0].length - (match[1] ?? "").length - 2;
        while (paren > 0 && /\s/.test(match[0][paren] ?? "")) paren--;
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

/* THE CATALOG BELONGS TO THE SHELL, and this is the check that keeps it there.
 *
 * `api.models` exists because a model list is not a list — it is a live read of every connected provider, which
 * credentials the sandbox actually holds, how much of each account's plan is left and which of them last refused
 * a turn. An extension CAN fetch `/{provider}/models` and `/{provider}/accounts` itself, and two of them did:
 * what they could build from the raw routes was a row of chips that offered providers with no credential, could
 * not offer a model endpoint or an ACP agent at all, and named accounts without being able to say which one had
 * headroom left. Both are back on `api.models` now, and nothing but this test stops the third.
 *
 * It fails on the DECLARATION as well as the call, because the permission is what makes the call reachable — a
 * manifest granted the route "just in case" is the next copy already half-written. If an extension ever has a
 * reason to read these routes raw, this list is where the reason gets written down. */
const CATALOG_ROUTE = /^\/[^/]+\/(models|accounts)$/;
const everyExtension = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, "intentic-extension.json")))
    .map((entry) => entry.name);

// Every sandbox call one extension's source makes — none for a data-only pack, which ships a manifest and no `src`.
const callsOf = (name: string): Call[] => {
    const dir = join(extensionsRoot, name, "src");
    if (!existsSync(dir)) {
        return [];
    }
    const texts = sourceFiles(dir).map((file) => readFileSync(file, "utf8"));
    const constants = scanStringConstants(texts);
    return texts.flatMap((text) => scanTypedCalls(text).concat(scanCalls(text, scanMethodHelpers(text), scanRouteSegments(text), constants)));
};

/* An extension's calls into its OWN /x namespace — exempt from declaration, mirroring the host (apiImpl.ts):
 * its backend is its own code from the same approved checkout, so there is no grant to conform to. Only the
 * extension's exact namespace is exempt; a call into another extension's namespace conforms like any core
 * route. The prefix is derived from the manifest the same way the host derives it (a baked/workspace
 * extension's routing id is publisher.name). */
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

/* EVERY extension in the directory, derived — never a hand-kept list.
 *
 * This check used to name seven extensions. Fourteen UI extensions ship, and three of the seven it omitted were
 * calling a route they had never declared: Acceptance asked for the browser listing behind its live-run column,
 * and the Pipelines and Deployments fix buttons both read the sandbox setting that names the model they are
 * about to spend. All three threw at the guard on every call, so all three features were silently dead — a
 * blank column and two buttons that could never say what they cost — while this file reported 97 passes.
 *
 * The lesson is not that the list was short; it is that a list of what to check ages badly against a directory
 * anyone can add to. Reading the directory instead means the day an extension lands it is already covered. */
const sandboxPermissionsOf = (name: string): readonly string[] => {
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(extensionsRoot, name, "intentic-extension.json"), "utf8")));
    return manifest.permissions?.sandbox ?? [];
};

// The extensions that reach the daemon from the browser. A data-only pack and a daemon-side one make no
// api.sandbox call at all, which is why this is filtered rather than asserted over the whole directory.
const callers = everyExtension.filter((name) => callsOf(name).length > 0);

/* The scanner is regex over source, so a silent failure to match would make every check below vacuously pass —
 * which is the shape the bug above already took once. An extension that DECLARES sandbox routes is one the
 * scanner must find calls in; if this fails, suspect the regexes before the manifest. */
test("the scanner finds calls in every extension that declares sandbox routes", () => {
    const declaring = everyExtension.filter((name) => sandboxPermissionsOf(name).length > 0);
    expect(declaring.filter((name) => !callers.includes(name))).toEqual([]);
});

// Callers with at least one call OUTSIDE their own namespace — an extension that only talks to its own
// backend (memory) has nothing left to declare, and an empty test.each is a vitest error, not a pass.
const declaringCallers = callers.filter((name) => declarableCallsOf(name).length > 0);

describe.each(declaringCallers)("%s declares every sandbox route it calls", (name) => {
    const permissions = sandboxPermissionsOf(name);
    test.each(declarableCallsOf(name).map((call) => [`${call.method} ${call.path}`, call] as const))("declares %s", (_label, call) => {
        expect(sandboxRouteAllowed(permissions, call.method, call.path)).toBe(true);
    });
});
