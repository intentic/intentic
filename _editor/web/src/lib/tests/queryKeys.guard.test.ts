import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";

// queryKeys.ts is the only spelling of a vue-query key, enforced by scanning the repo for three violations:
// 1. A cache key spelled as an inline array of string literals.
// 2. `sandboxKey` imported anywhere but the registry.
// 3. An extension keying one contract read by a name of its own (`api.sandbox.key("personas")`) instead of by the
//    procedure (`api.sandbox.readKey("personas.list")`): two packs that picked one name stored two shapes under it.

const appRoot = join(packageRoot(import.meta.url), `src`);
const registry = join(appRoot, `lib/queryKeys.ts`);

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

// Nothing to guard is a broken guard, not a passing one: a moved directory would otherwise read as a pass.
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

    // The daemon invalidates by name; a name that lands on no family and stands for no contract read lands on nothing,
    // the same silent failure as an inline literal. EXTENSION_OWNED covers names whose queries live in an extension
    // package, via `api.key(...)`.
    it(`gives every name the daemon can push a family or a contract read to land on`, () => {
        const EXTENSION_OWNED = new Set([`approvals`]);
        // Read from source, not import: the registry's chain reaches useSandbox, which wants a browser at import time.
        const source = readFileSync(registry, `utf8`);
        const families = [...source.matchAll(/=\s*family\(\s*`([^`]+)`/g)].map((match) => match[1]);
        const table = /PUSHED_READS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? ``;
        const bridged = [...table.matchAll(/^\s*"?([\w/-]+)"?:/gm)].map((match) => match[1]);
        expect(bridged).toContain(`settings`);
        const declared = new Set([...families, ...bridged]);
        const unlanded = [...new Set(WORKSPACE_STATE_FILES.flatMap((file) => file.invalidates))]
            .filter((name) => !EXTENSION_OWNED.has(name) && !declared.has(name))
            .toSorted();
        expect(unlanded, `add the read the name stands for to PUSHED_READS in lib/queryKeys.ts, or record it as extension-owned`).toEqual([]);
    });
});

// Extensions are bundled apart and can only reach the host's keys through the SDK, so their rule is the SDK's: a query
// whose `queryFn` calls one contract procedure is keyed by `api.sandbox.readKey(procedure, input)`, the host's own key
// for that read. `api.sandbox.key(...)` stays for what is not one contract read (a `json` route, a composite of
// several procedures). Read from source: the object literal around each `queryFn:`, and the queryKey it names, inline
// or as a `const` in the same file.
const extensionsRoot = join(repoRoot(import.meta.url), `_extensions`);
const extensionSources = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, `src`)))
    .flatMap((entry) => sourceFiles(join(extensionsRoot, entry.name, `src`)))
    .filter((file) => !file.endsWith(`.test.ts`))
    .map((file) => ({ path: relative(extensionsRoot, file).replaceAll(`\\`, `/`), text: readFileSync(file, `utf8`) }));

// The object literal a `queryFn:` sits in, by balancing braces outward from it.
const enclosingObject = (text: string, at: number): string => {
    let depth = 0;
    let open = -1;
    for (let i = at; i >= 0; i -= 1) {
        if (text[i] === `}`) {
            depth += 1;
        } else if (text[i] === `{`) {
            if (depth === 0) {
                open = i;
                break;
            }
            depth -= 1;
        }
    }
    if (open < 0) {
        return ``;
    }
    depth = 0;
    for (let i = open; i < text.length; i += 1) {
        if (text[i] === `{`) {
            depth += 1;
        } else if (text[i] === `}` && --depth === 0) {
            return text.slice(open, i + 1);
        }
    }
    return text.slice(open);
};

// What a query's key expression is built from: inline, or the initializer of the `const` it names.
const keyExpression = (object: string, file: string): string => {
    const inline = /queryKey:\s*([^\n]+)/.exec(object)?.[1];
    const named = inline === undefined ? (/\bqueryKey\b\s*,/.test(object) ? `queryKey` : undefined) : /^(\w+)(?:\.value)?,?\s*$/.exec(inline.trim())?.[1];
    if (named === undefined) {
        return inline ?? ``;
    }
    return new RegExp(`const ${named}\\s*=\\s*([^\\n]+(?:\\n\\s+[^\\n]+)?)`).exec(file)?.[1] ?? ``;
};

const handKeyedReads = (text: string): string[] =>
    [...text.matchAll(/\bqueryFn:/g)].flatMap((match) => {
        const object = enclosingObject(text, match.index);
        const procedures = new Set([...object.matchAll(/\.rpc\.(\w+)\.(\w+)\(/g)].map((call) => `${call[1]}.${call[2]}`));
        // One procedure is one contract read; several are a composite, which no single read's key could name. A paged read
        // holds pages rather than the procedure's answer, so it takes a name of its own, as WORKSPACE_SEARCH does here.
        if (procedures.size !== 1 || /\b(?:initialPageParam|getNextPageParam)\b/.test(object)) {
            return [];
        }
        const key = keyExpression(object, text);
        return /\bsandbox\.key\(/.test(key) && !/\breadKey\(/.test(key) ? [`${[...procedures][0]} keyed ${key.split(`\n`)[0]?.trim()}`] : [];
    });

describe(`extension cache keys`, () => {
    it(`scans every extension`, () => {
        expect(extensionSources.length).toBeGreaterThan(MIN_SCANNED);
    });

    it(`keys every extension's contract read by its procedure`, () => {
        const offenders = extensionSources.flatMap(({ path, text }) => handKeyedReads(text).map((read) => `${path}: ${read}`));
        expect(offenders, `key these with api.sandbox.readKey(procedure, input) and return the raw answer, reshaping in select`).toEqual([]);
    });

    it(`sees a hand-keyed read where there is one`, () => {
        // The detector itself, so a change to it that sees nothing reads as a failure rather than a pass.
        const inline = `useQuery({\n    queryKey: api.sandbox.key(\`personas\`),\n    queryFn: () => api.sandbox.rpc.personas.list(),\n});`;
        const named = `const queryKey = api.sandbox.key(\`ci-runs\`);\nuseQuery({ queryKey, queryFn: () => api.sandbox.rpc.ci.runs() });`;
        const derived = `useQuery({ queryKey: api.sandbox.readKey(\`personas.list\`), queryFn: () => api.sandbox.rpc.personas.list() });`;
        const composite = `useQuery({ queryKey: api.sandbox.key(\`both\`), queryFn: () => Promise.all([api.sandbox.rpc.a.one(), api.sandbox.rpc.b.two()]) });`;
        const paged = `useInfiniteQuery({\n    queryKey: api.sandbox.key(\`activity\`),\n    queryFn: ({ pageParam }) => api.sandbox.rpc.activity.list({ before: pageParam }),\n    initialPageParam: undefined,\n});`;
        expect([inline, named, derived, composite, paged].map((text) => handKeyedReads(text).length)).toEqual([1, 1, 0, 0, 0]);
    });
});
