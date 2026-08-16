import { execFileSync } from "node:child_process";
import { closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionUiNames } from "../names.mjs";

/* Builds the PUBLISHED @intentic/extension-ui — the artifact an author outside this monorepo compiles against.
 *
 * The kit is host-provided at run time: the app maps this module name into its import map, so a bundle that
 * marks it external lands on the shell's own component instances. That half has always worked. What an outside
 * author has never had is the other half — anything to compile against. `@intentic/ui`, where every one of
 * these components actually lives, is private and unpublishable (it is the whole app design system, and
 * publishing it would put a semver promise on all of it rather than on the curated slice the kit IS).
 *
 * So this produces two things and no source:
 *
 *   dist/index.js    the host bridge — the same re-export-from-the-global shim the app already serves at
 *                    /ext-shims/extension-ui.js, generated from the same names.mjs. Shipping it means an
 *                    author who FORGETS to mark the kit external still gets working code instead of a bundled
 *                    second copy of components that must be the shell's own to work at all.
 *   dist/types/      declarations only, for the slice this kit re-exports.
 *
 * THE PRUNED BARREL is the trick that makes the types shippable. `@intentic/ui`'s own barrel exports far more
 * than the kit does, and following it drags in `shiki` (the code highlighter) and `@primeuix/themes` — two
 * heavy dependencies an extension author would have to install to typecheck a screen that never highlights
 * code. Rewriting that barrel down to the names the kit actually re-exports drops both, and the published
 * package's whole external surface becomes `vue` (the host's own, already a peer) and `primevue` (six
 * primitives the kit deliberately passes through).
 *
 *   node scripts/build.mjs
 *
 * WIRED TO `prepack` AS WELL AS `build`, because the alternative fails silently and does so on the one day it
 * matters. Everything this package publishes lives under `dist/` — `main`, `types` and every `exports` target —
 * and `dist/` is gitignored. Pack a clean checkout without having built, and npm produces a perfectly valid
 * tarball containing `src/` and `names.mjs` and nothing else: no error, no warning, a real version number on
 * the registry, and an install whose `main` resolves to a file that is not there. That is verified rather than
 * feared — it is what packing this package did before `prepack` existed. The release does run `turbo run build`
 * first, so this is usually a three-second no-op; it is here so that being usually-true is not what the
 * correctness of a published artifact rests on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const EDITOR = resolve(PKG, "..");
const STAGING = join(PKG, ".types-staging");
const DIST = join(PKG, "dist");

const log = (message) => process.stdout.write(`${message}\n`);

// ── 1. Declarations for the kit AND the design system it re-exports ──────────────────────────────────────
// Emitted together with `_editor` as the root so the two land as siblings and their relative imports keep
// resolving. `include` is deliberately the whole of both: TypeScript emits only for files it was given as
// roots, and step 3 is what narrows the result to the reachable ones.
const tsconfig = join(STAGING, "tsconfig.json");
rmSync(STAGING, { recursive: true, force: true });
rmSync(DIST, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
writeFileSync(
    tsconfig,
    JSON.stringify({
        extends: resolve(EDITOR, "../_tools/tsconfig/tsconfig.vue.json"),
        compilerOptions: {
            noEmit: false,
            declaration: true,
            emitDeclarationOnly: true,
            skipLibCheck: true,
            outDir: join(STAGING, "out"),
            rootDir: EDITOR,
            tsBuildInfoFile: join(STAGING, "tsbuildinfo"),
        },
        include: [join(PKG, "src/**/*.ts"), join(EDITOR, "ui/src/**/*.ts"), join(EDITOR, "ui/src/**/*.vue")],
    }),
);
log(`emitting declarations…`);
execFileSync(join(PKG, "node_modules/.bin/vue-tsc"), ["-p", tsconfig], { stdio: "inherit" });

const OUT = join(STAGING, "out");
const KIT_ENTRY = join(OUT, "extension-ui/src/index.d.ts");
const UI_BARREL = join(OUT, "ui/src/index.d.ts");

// ── 2. Prune the design system's barrel to what the kit re-exports ───────────────────────────────────────
// Each barrel line is `export { … } from "./somewhere.js"`. Keep a line only if it still names something the
// kit hands out, and drop the names on it that the kit does not — otherwise the reachable graph is the whole
// design system rather than the slice.
/* What the kit re-exports, values AND types, read off its own emitted declaration rather than off names.mjs —
 * that list is the shim generator's, so it carries only the runtime names, and a barrel pruned to it would
 * drop every type the kit hands out (`IconName`, `NavGroup`, `StatusVariant`…). Reading the declaration is
 * also the only version that cannot drift: it IS what the package exports. */
const exportedNames = (source, fromPattern) => {
    const names = new Set();
    for (const statement of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";?/gu)) {
        if (!fromPattern.test(statement[2])) {
            continue;
        }
        for (const entry of statement[1].split(`,`).map((part) => part.trim())) {
            if (entry !== ``) {
                names.add((/^(\w+)\s+as\s+/u.exec(entry)?.[1] ?? entry).replace(/^type\s+/u, ``));
            }
        }
    }
    return names;
};
const wanted = exportedNames(readFileSync(KIT_ENTRY, `utf8`), /^@intentic\/ui/u);

const prunedBarrel = (source) => {
    const kept = [];
    for (const statement of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";?/gu)) {
        const [, typeOnly, names, from] = statement;
        const survivors = names
            .split(`,`)
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ``)
            .filter((entry) => wanted.has((/\bas\s+(\w+)$/u.exec(entry)?.[1] ?? entry).replace(/^type\s+/u, ``)));
        if (survivors.length > 0) {
            kept.push(`export ${typeOnly ?? ``}{ ${survivors.join(`, `)} } from "${from}";`);
        }
    }
    return `${kept.join(`\n`)}\n`;
};
const barrelBefore = readFileSync(UI_BARREL, `utf8`);
writeFileSync(UI_BARREL, prunedBarrel(barrelBefore));
log(`pruned the design-system barrel: ${barrelBefore.split(`\n`).length} lines → ${readFileSync(UI_BARREL, `utf8`).split(`\n`).length}`);

// ── 3. Keep only what the kit's entry can actually reach ─────────────────────────────────────────────────
const reachable = new Set();
const externals = new Map();
const resolveRelative = (from, spec) => {
    const base = resolve(dirname(from), spec.replace(/\.js$/u, ``));
    for (const candidate of [`${base}.d.ts`, join(base, `index.d.ts`)]) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
};
// A bare `@intentic/ui…` specifier points at the sibling tree emitted above, not at anything a consumer will
// install — step 4 rewrites it to a relative path, and the walk has to follow it the same way.
const resolveUi = (spec) => {
    const rest = spec === `@intentic/ui` ? `index` : spec.slice(`@intentic/ui/`.length);
    for (const candidate of [join(OUT, `ui/src`, `${rest}.d.ts`), join(OUT, `ui/src`, rest, `index.d.ts`)]) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
};
const walk = (file) => {
    if (reachable.has(file)) {
        return;
    }
    reachable.add(file);
    for (const match of readFileSync(file, `utf8`).matchAll(/from\s+"([^"]+)"/gu)) {
        const spec = match[1];
        const next = spec.startsWith(`.`) ? resolveRelative(file, spec) : spec.startsWith(`@intentic/ui`) ? resolveUi(spec) : undefined;
        if (next !== undefined) {
            walk(next);
        } else if (!spec.startsWith(`.`) && !spec.startsWith(`@intentic/`)) {
            externals.set(spec, (externals.get(spec) ?? 0) + 1);
        }
    }
};
walk(KIT_ENTRY);
walk(join(OUT, `extension-ui/src/format.d.ts`));

for (const file of reachable) {
    const target = join(DIST, `types`, relative(OUT, file));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
}
log(`kept ${reachable.size} of the emitted declarations`);

// ── 4. Point the kit's own declarations at the vendored copy ─────────────────────────────────────────────
// `@intentic/ui` is not something a consumer can install, so the published declarations must not name it.
for (const name of [`index.d.ts`, `format.d.ts`]) {
    const file = join(DIST, `types/extension-ui/src`, name);
    let descriptor;
    try {
        descriptor = openSync(file, `r+`);
    } catch (error) {
        if (error !== null && typeof error === `object` && `code` in error && error.code === `ENOENT`) {
            continue;
        }
        throw error;
    }
    try {
        const rewritten = readFileSync(descriptor, `utf8`).replaceAll(/"@intentic\/ui(\/[^"]*)?"/gu, (_, sub) => {
            const target = join(DIST, `types/ui/src`, sub === undefined ? `index.js` : `${sub.slice(1)}/index.js`);
            const withoutIndex = join(DIST, `types/ui/src`, `${sub === undefined ? `index` : sub.slice(1)}.js`);
            const chosen = existsSync(withoutIndex.replace(/\.js$/u, `.d.ts`)) ? withoutIndex : target;
            const rel = relative(dirname(file), chosen);
            return `"${rel.startsWith(`.`) ? rel : `./${rel}`}"`;
        });
        const bytes = Buffer.from(rewritten);
        let written = 0;
        while (written < bytes.length) {
            written += writeSync(descriptor, bytes, written, bytes.length - written, written);
        }
        ftruncateSync(descriptor, bytes.length);
    } finally {
        closeSync(descriptor);
    }
}

// ── 5. The runtime: the host bridge ──────────────────────────────────────────────────────────────────────
const isIdentifier = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
const bridgeNames = extensionUiNames.filter((name) => isIdentifier(name)).toSorted();
writeFileSync(
    join(DIST, `index.js`),
    [
        `// Generated by scripts/build.mjs — do not edit.`,
        `/* The kit is HOST-PROVIDED. These components must be the shell's own instances — a second copy would`,
        ` * render unthemed, outside the app's reactivity and outside its one query cache — so this module reads`,
        ` * them off the bridge the host publishes rather than containing any. Marking "@intentic/extension-ui"`,
        ` * external in your bundler is the tidier route (the app's import map answers it); this file is what makes`,
        ` * forgetting to do that harmless instead of silent. */`,
        `const host = globalThis.__intenticHost;`,
        `if (host === undefined) {`,
        `    throw new Error("@intentic/extension-ui was loaded outside an intentic host — its components come from the app, not from this package.");`,
        `}`,
        `const m = host.modules["@intentic/extension-ui"];`,
        ...bridgeNames.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
        ``,
    ].join(`\n`),
);

/* `@intentic/extension-ui/format` is the same bridge narrowed to the date and size helpers — the subpath
 * exists because an extension's pure logic wants them without pulling a component graph in behind them, and a
 * published entry that quietly handed back the whole kit would defeat exactly that. Its names are read from
 * the emitted declaration rather than listed here, so the two cannot disagree. */
const formatNames = [...exportedNames(readFileSync(join(DIST, `types/extension-ui/src/index.d.ts`), `utf8`), /format/u)]
    .filter((name) => isIdentifier(name))
    .toSorted();
writeFileSync(
    join(DIST, `format.js`),
    [
        `// Generated by scripts/build.mjs — do not edit.`,
        `// The formatting half of the kit, off the same host bridge as ./index.js.`,
        `const host = globalThis.__intenticHost;`,
        `if (host === undefined) {`,
        `    throw new Error("@intentic/extension-ui was loaded outside an intentic host — its helpers come from the app, not from this package.");`,
        `}`,
        `const m = host.modules["@intentic/extension-ui"];`,
        ...formatNames.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
        ``,
    ].join(`\n`),
);

rmSync(STAGING, { recursive: true, force: true });
log(`dist/index.js: ${bridgeNames.length} exports · dist/format.js: ${formatNames.length}`);
log(`external packages the published types need: ${[...externals.keys()].toSorted().join(`, `)}`);
