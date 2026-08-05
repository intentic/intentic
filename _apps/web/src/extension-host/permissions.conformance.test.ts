import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionManifestSchema, sandboxRouteAllowed } from "@intentic/extension-api";
import { describe, expect, test } from "vitest";

/* Conformance: every daemon route a first-party extension calls through api.sandbox.request/json must be declared
 * in its manifest's permissions.sandbox — otherwise the host (apiImpl.ts) would throw at runtime. This scans each
 * builtin extension's source and fails if a call isn't covered, so a newly-added route can't ship undeclared. */

const extensionsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../_extensions");

// The builtin UI extensions loaded by extension-host/builtins.ts (each reaches the daemon via api.sandbox).
const BUILTINS = ["activity", "automations", "documentation", "logs", "memory", "preview", "repo-apps"];

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

// Every api.sandbox.request/json (or host().sandbox.*) call in a source file: its first string/template-literal
// path arg (normalized — query stripped, `${…}` → `*`) and its method — a literal `method:` in the options
// object, else a method-producing helper passed as the options, else GET.
const scanCalls = (text: string, helpers: Map<string, string>): Call[] => {
    const calls: Call[] = [];
    const re = /sandbox\.(?:json|request)(?:<[^>]*>)?\(\s*[`'"]([^`'"]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const raw = match[1] ?? "";
        const path = raw.split("?")[0]?.replace(/\$\{[^}]*\}/g, "*") ?? "";
        // The call's opening `(` sits just before the path's quote (regex allows only `\s*` between them). Anchor
        // there rather than lastIndexOf("(") — a path like `/x/${encodeURIComponent(id)}` carries its own parens.
        let paren = match[0].length - raw.length - 2;
        while (paren > 0 && /\s/.test(match[0][paren] ?? "")) paren--;
        const args = callArgs(text, match.index + paren);
        const literal = /method:\s*[`'"]([A-Za-z]+)/.exec(args)?.[1];
        const helper = literal ? undefined : [...helpers].find(([helperName]) => new RegExp(`\\b${helperName}\\s*\\(`).test(args));
        const method = literal ?? helper?.[1] ?? "GET";
        calls.push({ method, path });
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

describe.each(everyExtension)("%s reads models and accounts through api.models, not the daemon", (name) => {
    const root = join(extensionsRoot, name);
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(root, "intentic-extension.json"), "utf8")));

    test("declares no model or account catalog route", () => {
        const declared = (manifest.permissions?.sandbox ?? []).filter((route) => CATALOG_ROUTE.test(route.replace(/^[A-Z]+\s+/, "")));
        expect(declared).toEqual([]);
    });

    test("calls no model or account catalog route", () => {
        const dir = join(root, "src");
        const called = !existsSync(dir)
            ? []
            : sourceFiles(dir)
                  .flatMap((file) => {
                      const text = readFileSync(file, "utf8");
                      return scanCalls(text, scanMethodHelpers(text));
                  })
                  .filter((call) => CATALOG_ROUTE.test(call.path));
        expect(called).toEqual([]);
    });
});

describe.each(BUILTINS)("%s declares every sandbox route it calls", (name) => {
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(extensionsRoot, name, "intentic-extension.json"), "utf8")));
    const permissions = manifest.permissions?.sandbox ?? [];
    const calls = sourceFiles(join(extensionsRoot, name, "src")).flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return scanCalls(text, scanMethodHelpers(text));
    });

    test("makes at least one sandbox call (scanner sanity)", () => {
        expect(calls.length).toBeGreaterThan(0);
    });

    test.each(calls.map((call) => [`${call.method} ${call.path}`, call] as const))("declares %s", (_label, call) => {
        expect(sandboxRouteAllowed(permissions, call.method, call.path)).toBe(true);
    });
});
