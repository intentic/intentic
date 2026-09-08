import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";

// queryKeys.ts is the only spelling of a vue-query key, enforced by scanning the repo for two violations:
// 1. A cache key spelled as an inline array of string literals.
// 2. `sandboxKey` imported anywhere but the registry.

const here = import.meta.dirname;
const appRoot = resolve(here, `..`);
const registry = resolve(here, `queryKeys.ts`);

// apiImpl hands `sandboxKey` to extensions via `api.key(...)`, whose key paths this registry cannot enumerate.
const EXEMPT = new Map<string, string>([[`extension-host/apiImpl.ts`, `hands sandboxKey to extensions as api.key()`]]);

// Whether a file imports the scoping rule; prose merely mentioning `sandboxKey` (in a comment) is not a violation, only
// an import reaches it.
const importsSandboxKey = (text: string): boolean => /import\s*\{[^}]*\bsandboxKey\b[^}]*\}/.test(text);

const sourceFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== `node_modules` && entry.name !== `dist`) {
                out.push(...sourceFiles(full));
            }
        } else if (entry.name.endsWith(`.ts`) || entry.name.endsWith(`.vue`)) {
            out.push(full);
        }
    }
    return out;
};

// The registry states the paths and this file quotes them; every other file in the app is subject to the rules.
const AUTHORITIES = new Set([registry, import.meta.filename]);

const appSources = sourceFiles(appRoot)
    .filter((file) => !AUTHORITIES.has(file))
    .map((file) => ({ path: relative(appRoot, file).replaceAll(`\\`, `/`), text: readFileSync(file, `utf8`) }));

// Nothing to guard is a broken guard, not a passing one: a moved directory would otherwise read as green.
const MIN_SCANNED = 200;

// The array literal after a `queryKey:`, read by balancing brackets rather than regex, since a key can span lines or
// nest arrays and a lazy pattern stops at the first inner bracket.
const queryKeyArrays = (text: string): string[] => {
    const found: string[] = [];
    for (const match of text.matchAll(/queryKey:\s*\[/g)) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        for (let i = open; i < text.length; i += 1) {
            const char = text[i];
            if (char === `[`) {
                depth += 1;
            }
            if (char === `]`) {
                depth -= 1;
                if (depth === 0) {
                    found.push(text.slice(open + 1, i));
                    break;
                }
            }
        }
    }
    return found;
};

// A path written a second time: every element is a string literal, so none of it came from the registry. `[key]` and
// `[...FAMILY.of(), UNPERSISTED, id]` both carry something that did, and pass.
const isSpelledInline = (contents: string): boolean => {
    const elements = contents
        .split(`,`)
        .map((element) => element.trim())
        .filter((element) => element.length > 0);
    return elements.length > 0 && elements.every((element) => /^(`[^`$]*`|"[^"]*"|'[^']*')$/.test(element));
};

describe(`cache key registry`, () => {
    it(`scans the whole app`, () => {
        expect(appSources.length).toBeGreaterThan(MIN_SCANNED);
    });

    // Tests are the deliberate exception, for the opposite reason: a test pinning the shape a family produces has to
    // spell it out, or it can never disagree with the implementation.
    it(`keeps every cache key out of inline literals`, () => {
        const offenders = appSources
            .filter(({ path }) => !path.endsWith(`.test.ts`))
            .flatMap(({ path, text }) =>
                queryKeyArrays(text)
                    .filter(isSpelledInline)
                    .map((contents) => `${path}: queryKey: [${contents}]`),
            );
        expect(offenders, `spell these as a family in composables/queryKeys.ts and use .of() or .every`).toEqual([]);
    });

    it(`keeps the scoping rule inside the registry`, () => {
        const offenders = appSources.filter(({ path, text }) => !EXEMPT.has(path) && importsSandboxKey(text)).map(({ path }) => path);
        expect(offenders, `scope keys through a family in composables/queryKeys.ts instead of importing sandboxKey`).toEqual([]);
    });

    it(`keeps every exemption real`, () => {
        // A stale exemption (file gone, or no longer importing sandboxKey) is a hole nobody still needs.
        const stale = [...EXEMPT.keys()].filter((path) => !appSources.some((source) => source.path === path && importsSandboxKey(source.text)));
        expect(stale, `drop these from EXEMPT — they no longer import sandboxKey`).toEqual([]);
    });

    // The daemon invalidates by name; a name with no matching family here lands on nothing, the same silent failure as
    // an inline literal. EXTENSION_OWNED covers names whose queries live in an extension package, via `api.key(...)`.
    it(`gives every name the daemon can push a family to land on`, () => {
        const EXTENSION_OWNED = new Set([`approvals`]);
        // Read from source, not import: the registry's chain reaches useSandbox, which wants a browser at import time.
        const declared = new Set([...readFileSync(registry, `utf8`).matchAll(/=\s*family\(\s*`([^`]+)`/g)].map((match) => match[1]));
        const unlanded = [...new Set(WORKSPACE_STATE_FILES.flatMap((file) => file.invalidates))]
            .filter((name) => !EXTENSION_OWNED.has(name) && !declared.has(name))
            .toSorted();
        expect(unlanded, `add a family in composables/queryKeys.ts, or record the name as extension-owned`).toEqual([]);
    });
});
