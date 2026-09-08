import { execFileSync } from "node:child_process";
import {
    closeSync,
    cpSync,
    existsSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { byName, root as ROOT } from "../../../_tools/checks/lib/repo.mjs";
import { extensionUiNames } from "../names.mjs";

// Builds the published @intentic/extension-ui: dist/index.js, a host-bridge shim re-exporting the shell's own component
// instances, and dist/types/, declarations pruned to what the kit re-exports. Wired to prepack as well as build, since
// dist/ is gitignored and packing without a fresh build would silently ship an empty tarball.

const HERE = import.meta.dirname;
const PKG = resolve(HERE, "..");
// Finds other workspace packages by name rather than by relative path, so a package moving to a new directory can't
// silently break the resolution.
const dirOf = (name) => {
    const found = byName.get(name);
    if (found === undefined) {
        throw new Error(`${name} is not a workspace package, and @intentic/extension-ui is built from its sources.`);
    }
    return found.dir;
};
const UI = dirOf("@intentic/ui");
const TSCONFIG = dirOf("@intentic/tsconfig");
const STAGING = join(PKG, ".types-staging");
const DIST = join(PKG, "dist");

const log = (message) => process.stdout.write(`${message}\n`);

// Empties a directory without removing it: `rmSync(dir, { recursive: true })` fails with EBUSY when dir is a mount
// point, the normal case for build output in a sandbox.
const empty = (dir) => {
    if (existsSync(dir)) {
        for (const entry of readdirSync(dir)) {
            rmSync(join(dir, entry), { recursive: true, force: true });
        }
        return;
    }
    mkdirSync(dir, { recursive: true });
};

// ── 1. Declarations for the kit AND the design system it re-exports ──
// Emitted together with the repository as rootDir, since the two packages live in different workspace directories; step
// 3 narrows the result to what's reachable.
const tsconfig = join(STAGING, "tsconfig.json");
empty(STAGING);
empty(DIST);
writeFileSync(
    tsconfig,
    JSON.stringify({
        extends: join(TSCONFIG, "tsconfig.vue.json"),
        compilerOptions: {
            noEmit: false,
            declaration: true,
            emitDeclarationOnly: true,
            skipLibCheck: true,
            outDir: join(STAGING, "out"),
            rootDir: ROOT,
            tsBuildInfoFile: join(STAGING, "tsbuildinfo"),
        },
        include: [join(PKG, "src/**/*.ts"), join(UI, "src/**/*.ts"), join(UI, "src/**/*.vue")],
    }),
);
log(`emitting declarations…`);
execFileSync(join(PKG, "node_modules/.bin/vue-tsc"), ["-p", tsconfig], { stdio: "inherit" });

const OUT = join(STAGING, "out");
const OUT_KIT = join(OUT, relative(ROOT, PKG), "src");
const OUT_UI = join(OUT, relative(ROOT, UI), "src");
const KIT_ENTRY = join(OUT_KIT, "index.d.ts");
const UI_BARREL = join(OUT_UI, "index.d.ts");

// Maps a `@intentic/ui/…` specifier to its emitted declaration via that package's own export map, since a subpath is a
// name, not a directory path.
const uiExports = JSON.parse(readFileSync(join(UI, `package.json`), `utf8`)).exports;
const uiDeclaration = (spec) => {
    const entry = uiExports[spec === `@intentic/ui` ? `.` : `.${spec.slice(`@intentic/ui`.length)}`];
    const source = typeof entry === `string` ? entry : entry?.types;
    return source === undefined
        ? undefined
        : join(OUT_UI, relative(join(UI, `src`), resolve(UI, source)))
              .replace(/\.ts$/u, `.d.ts`)
              .replace(/\.vue$/u, `.vue.d.ts`);
};

// ── 2. Prune the design system's barrel to what the kit re-exports ──
// Keeps a barrel line only if it still names something the kit hands out, dropping heavy dependencies (shiki,
// @primeuix/themes) the kit never uses.
// What the kit re-exports, values and types, read off its own emitted declaration rather than off names.mjs, which
// lists only runtime names.
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

// ── 3. Keep only what the kit's entry can actually reach ──
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
// A bare `@intentic/ui…` specifier points at the tree emitted above, not at anything a consumer will install; step 4
// rewrites it to a relative path.
const resolveUi = (spec) => {
    const declaration = uiDeclaration(spec);
    return declaration !== undefined && existsSync(declaration) ? declaration : undefined;
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
walk(join(OUT_KIT, `format.d.ts`));

// Published as two directories side by side, `types/extension-ui/src/…` and `types/ui/src/…`, since `rootDir` is the
// repository and the emit is nested by workspace directory.
const published = (file) => {
    for (const [emitted, name] of [
        [OUT_KIT, `extension-ui`],
        [OUT_UI, `ui`],
    ]) {
        const within = relative(emitted, file);
        if (within !== `` && !within.startsWith(`..`) && !isAbsolute(within)) {
            return join(DIST, `types`, name, `src`, within);
        }
    }
    throw new Error(`reachable declaration outside the kit and the design system: ${file}`);
};

for (const file of reachable) {
    const target = published(file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
}
log(`kept ${reachable.size} of the emitted declarations`);

// ── 4. Point the kit's own declarations at the vendored copy ──
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
        const rewritten = readFileSync(descriptor, `utf8`).replaceAll(/"(@intentic\/ui(?:\/[^"]*)?)"/gu, (_, spec) => {
            const declaration = uiDeclaration(spec);
            if (declaration === undefined || !existsSync(declaration)) {
                throw new Error(`${name} imports ${spec}, which @intentic/ui does not export as a file this build emitted.`);
            }
            const rel = relative(dirname(file), published(declaration).replace(/\.d\.ts$/u, `.js`));
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

// ── 5. The runtime: the host bridge ──
const isIdentifier = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
const bridgeNames = extensionUiNames.filter((name) => isIdentifier(name)).toSorted();
writeFileSync(
    join(DIST, `index.js`),
    [
        `// Generated by scripts/build.mjs: do not edit.`,
        `/* The kit is HOST-PROVIDED. These components must be the shell's own instances: a second copy would`,
        ` * render unthemed, outside the app's reactivity and outside its one query cache, so this module reads`,
        ` * them off the bridge the host publishes rather than containing any. Marking "@intentic/extension-ui"`,
        ` * external in your bundler is the tidier route (the app's import map answers it); this file is what makes`,
        ` * forgetting to do that harmless instead of silent. */`,
        `const host = globalThis.__intenticHost;`,
        `if (host === undefined) {`,
        `    throw new Error("@intentic/extension-ui was loaded outside an intentic host: its components come from the app, not from this package.");`,
        `}`,
        `const m = host.modules["@intentic/extension-ui"];`,
        ...bridgeNames.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
        ``,
    ].join(`\n`),
);

// `@intentic/extension-ui/format` is the same bridge narrowed to the date and size helpers, for logic that wants them
// without the component graph attached.
const formatNames = [...exportedNames(readFileSync(join(DIST, `types/extension-ui/src/index.d.ts`), `utf8`), /format/u)]
    .filter((name) => isIdentifier(name))
    .toSorted();
writeFileSync(
    join(DIST, `format.js`),
    [
        `// Generated by scripts/build.mjs: do not edit.`,
        `// The formatting half of the kit, off the same host bridge as ./index.js.`,
        `const host = globalThis.__intenticHost;`,
        `if (host === undefined) {`,
        `    throw new Error("@intentic/extension-ui was loaded outside an intentic host: its helpers come from the app, not from this package.");`,
        `}`,
        `const m = host.modules["@intentic/extension-ui"];`,
        ...formatNames.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
        ``,
    ].join(`\n`),
);

rmSync(STAGING, { recursive: true, force: true });
log(`dist/index.js: ${bridgeNames.length} exports · dist/format.js: ${formatNames.length}`);
log(`external packages the published types need: ${[...externals.keys()].toSorted().join(`, `)}`);
