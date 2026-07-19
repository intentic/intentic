import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionManifestSchema, sandboxRouteAllowed } from "@intentic/extension-api";
import { describe, expect, test } from "vitest";

/* Conformance: every daemon route a first-party extension calls through api.sandbox.request/json must be declared
 * in its manifest's permissions.sandbox — otherwise the host (apiImpl.ts) would throw at runtime. This scans each
 * builtin extension's source and fails if a call isn't covered, so a newly-added route can't ship undeclared. */

const extensionsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../_extensions");

// The builtin UI extensions loaded by extension-host/builtins.ts (each reaches the daemon via api.sandbox).
const BUILTINS = ["activity", "automations", "logs", "preview", "repo-apps"];

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

// Every api.sandbox.request/json (or host().sandbox.*) call in a source file: its first string/template-literal
// path arg (normalized — query stripped, `${…}` → `*`) and the method from the following options object (GET default).
const scanCalls = (text: string): Call[] => {
    const calls: Call[] = [];
    const re = /sandbox\.(?:json|request)(?:<[^>]*>)?\(\s*[`'"]([^`'"]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const raw = match[1] ?? "";
        const path = raw.split("?")[0]?.replace(/\$\{[^}]*\}/g, "*") ?? "";
        const window = text.slice(match.index, match.index + 300);
        const method = /method:\s*[`'"]([A-Za-z]+)/.exec(window)?.[1] ?? "GET";
        calls.push({ method, path });
    }
    return calls;
};

describe.each(BUILTINS)("%s declares every sandbox route it calls", (name) => {
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(extensionsRoot, name, "intentic-extension.json"), "utf8")));
    const permissions = manifest.permissions?.sandbox ?? [];
    const calls = sourceFiles(join(extensionsRoot, name, "src")).flatMap((file) => scanCalls(readFileSync(file, "utf8")));

    test("makes at least one sandbox call (scanner sanity)", () => {
        expect(calls.length).toBeGreaterThan(0);
    });

    test.each(calls.map((call) => [`${call.method} ${call.path}`, call] as const))("declares %s", (_label, call) => {
        expect(sandboxRouteAllowed(permissions, call.method, call.path)).toBe(true);
    });
});
