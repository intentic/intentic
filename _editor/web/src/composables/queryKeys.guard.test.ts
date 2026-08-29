import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";

/* THE CACHE KEY REGISTRY, MADE UNAVOIDABLE.
 *
 * A vue-query key is a path, and a path is easy to type twice. It used to be: a query registered under
 * `sandboxKey("git","changes")` and six other files invalidated `["git","changes"]`, a literal nothing held to
 * the first. The failure that costs is silent: a key that matches nothing invalidates nothing, so the screen
 * keeps showing what it had and no error is raised anywhere. Worse, the two spellings are not equivalent:
 * `sandboxKey` APPENDS the active sandbox id, so the bare literal reaches EVERY sandbox's entry and the scoped
 * one reaches only the active sandbox's. Both were in use and neither said which it meant.
 *
 * queryKeys.ts is the answer to that, and these are the two rules that keep it the only answer:
 *
 *   1. A cache key is never spelled inline. An array of string literals handed to a `queryKey` is the exact
 *      shape of a path written a second time, so it is refused wherever it appears.
 *   2. `sandboxKey` is the registry's private scoping rule. Calling it anywhere else re-opens door 1 by
 *      another name.
 *
 * Scanned rather than listed, on the repo's rule: a list of "files that touch the cache" is a list that is
 * wrong within a week, and the file that gets added to it last is the one that would have needed it. */

const here = import.meta.dirname;
const appRoot = resolve(here, `..`);
const registry = resolve(here, `queryKeys.ts`);

/* The one importer that is not the registry, because the rule cannot hold there rather than because it is
 * inconvenient: apiImpl hands `sandboxKey` to EXTENSIONS as `api.key(...)`. Their key paths are theirs,
 * declared in their own packages; a registry in this app cannot enumerate them and should not try.
 *
 * useSandbox needs no entry: it DEFINES `sandboxKey` rather than importing it, and holds the one key with no
 * family (the sandbox list, which is the registry of all sandboxes rather than data from one). */
const EXEMPT = new Map<string, string>([[`extension-host/apiImpl.ts`, `hands sandboxKey to extensions as api.key()`]]);

/* Whether a file reaches for the scoping rule, asked as "does it IMPORT it". Prose mentions it too: the
 * comment in sandboxScope explaining why client state needs its own re-scoping is a useful sentence, not a
 * violation, and an import is the only way to actually get at it. */
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

/* The array literal that follows a `queryKey`, read by balancing brackets rather than by regex: a key can span
 * lines and can hold nested arrays, and a lazy `\[[^\]]*\]` silently stops at the first inner bracket. */
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

// A path written a second time: every element is a string literal, so nothing in it came from the registry.
// `[key]` and `[...FAMILY.of(), UNPERSISTED, id]` both carry something that did, and both pass.
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

    /* Tests are the deliberate exception, and for the opposite reason to the rule. A test that pins the SHAPE a
     * family produces (the sandbox predicate matching ["workspace","tree","all","sbx-1"] and not "sbx-2") has
     * to spell that shape out, or it restates the implementation and can never disagree with it. */
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
        // An exemption naming a file that no longer exists, or no longer reaches for the scoping rule, is a
        // hole someone is still paying for and nobody is still getting anything from.
        const stale = [...EXEMPT.keys()].filter((path) => !appSources.some((source) => source.path === path && importsSandboxKey(source.text)));
        expect(stale, `drop these from EXEMPT — they no longer import sandboxKey`).toEqual([]);
    });

    /* THE OTHER END OF THE WIRE. The daemon pushes staleness BY NAME: a write to `.intentic/config/personas.json`
     * carries `invalidates: ["personas","capabilities","manifests"]` from the contract's WORKSPACE_STATE_FILES,
     * and systemEvents hands that bare name to invalidateQueries. A name on that list with no family here is a
     * push that lands on nothing: the file changes, the daemon reports it, and the screen does not move. It is
     * the same silent failure as an inline literal, arriving from the other side of the contract, so it is
     * checked the same way rather than left to be noticed.
     *
     * EXTENSION_OWNED is for names whose queries live in an extension package: those register through
     * `api.key(...)` (see the apiImpl exemption above) and this app cannot enumerate them. */
    it(`gives every name the daemon can push a family to land on`, () => {
        const EXTENSION_OWNED = new Set([`drafts`]);
        // Read from the registry's SOURCE rather than by importing it: the registry reaches useSandbox, and
        // that module's chain wants a browser at import time. Everything else here is a source scan anyway.
        const declared = new Set([...readFileSync(registry, `utf8`).matchAll(/=\s*family\(\s*`([^`]+)`/g)].map((match) => match[1]));
        const unlanded = [...new Set(WORKSPACE_STATE_FILES.flatMap((file) => file.invalidates))]
            .filter((name) => !EXTENSION_OWNED.has(name) && !declared.has(name))
            .toSorted();
        expect(unlanded, `add a family in composables/queryKeys.ts, or record the name as extension-owned`).toEqual([]);
    });
});
