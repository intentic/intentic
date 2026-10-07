import { plugin } from "bun";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SFCDescriptor, type SFCScriptBlock, compileScript, compileTemplate, parse, version } from "vue/compiler-sfc";

// A `.vue` import under bun test: script (setup or classic) plus the template as a render function. Styles are
// dropped, since nothing under jsdom observes a stylesheet; a suite that asserts on CSS belongs in Playwright.

// A `<script setup>` inlines its template into the script; every other shape needs the render function compiled apart.
const renderFunction = (descriptor: SFCDescriptor, script: SFCScriptBlock | undefined, id: string, path: string): string | undefined => {
    if (descriptor.template === null || (script !== undefined && descriptor.scriptSetup !== null)) {
        return undefined;
    }
    return compileTemplate({
        source: descriptor.template.content,
        filename: path,
        id,
        compilerOptions: script?.bindings === undefined ? {} : { bindingMetadata: script.bindings },
    }).code;
};

const compileSfc = (path: string, source: string): string => {
    const { descriptor, errors } = parse(source, { filename: path });
    if (errors.length > 0) {
        throw new Error(`${path}: ${errors.map((error) => error.message).join(`; `)}`);
    }
    const id = Bun.hash(path).toString(16).slice(0, 8);
    const hasScript = descriptor.script !== null || descriptor.scriptSetup !== null;
    const script = hasScript ? compileScript(descriptor, { id, inlineTemplate: descriptor.scriptSetup !== null }) : undefined;
    const code = script?.content ?? `export default {};`;
    const render = renderFunction(descriptor, script, id, path);
    return render === undefined
        ? code
        : `${code.replace(/export\s+default/, `const __sfc__ =`)}\n${render}\n__sfc__.render = render;\nexport default __sfc__;`;
};

// THE COMPILED OUTPUT IS KEPT ON DISK, because `suites` runs every file `--isolate`d: each test file gets a fresh module
// registry, so every component it imports is compiled again, and the compile is the expensive half of loading one.
// Measured on 40 of the web's test files (2026-10-07): 980 compiles of 119 distinct components, 11.8 s of compiling in a
// 28 s run, which a warm cache took to 14 s. The web suite has 875 files, and CI ran it with this cost in every one.
//
// Keyed by everything the output is a function of: the compiler's version, this transform's (bump TRANSFORM when the
// code above changes what it emits), the path (the scope id is derived from it) and the file's bytes. So a stale entry
// cannot be read, only orphaned, and the daily prune below drops what nothing has read for two weeks. Every cache
// failure is a compile instead: a read-only home or a full disk costs the time, never the run.
const TRANSFORM = 1;
const CACHE_DIR = process.env[`VUE_SFC_CACHE_DIR`] ?? join(homedir(), `.cache`, `intentic-vue-sfc`);
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

const keyOf = (path: string, source: string): string => Bun.hash(`${String(TRANSFORM)}\0${version}\0${path}\0${source}`).toString(36);

const cached = (key: string): string | undefined => {
    try {
        return readFileSync(join(CACHE_DIR, `${key}.js`), `utf8`);
    } catch {
        // allow(silent-catch): an absent or unreadable entry is a miss, and a miss compiles
        return undefined;
    }
};

// Once a day per cache, on the first write: entries are read through `readFileSync`, which leaves the mtime alone, so
// age is time since the entry was WRITTEN. Two weeks is long past any branch a checkout returns to between writes.
const pruneOncePerDay = (): void => {
    const utcDay = new Date().toISOString().slice(0, 10);
    const marker = join(CACHE_DIR, `.pruned-${utcDay}`);
    try {
        statSync(marker);
        return;
    } catch {
        // allow(silent-catch): no marker for today is the signal to prune
    }
    try {
        writeFileSync(marker, ``);
        const cutoff = Date.now() - STALE_MS;
        for (const name of readdirSync(CACHE_DIR)) {
            const entry = join(CACHE_DIR, name);
            if (statSync(entry).mtimeMs < cutoff) {
                rmSync(entry, { force: true });
            }
        }
    } catch {
        // allow(silent-catch): a prune that cannot run leaves entries for the next day's
    }
};

const store = (key: string, code: string): void => {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        // Written beside its name and renamed, so a worker reading the entry while another writes it sees all or nothing.
        const partial = join(CACHE_DIR, `${key}.${String(process.pid)}.partial`);
        writeFileSync(partial, code);
        renameSync(partial, join(CACHE_DIR, `${key}.js`));
        pruneOncePerDay();
    } catch {
        // allow(silent-catch): an entry that cannot be written is compiled again next time
    }
};

export const loadSfc = (path: string): string => {
    const source = readFileSync(path, `utf8`);
    const key = keyOf(path, source);
    const hit = cached(key);
    if (hit !== undefined) {
        return hit;
    }
    const code = compileSfc(path, source);
    store(key, code);
    return code;
};

plugin({
    name: `vue-sfc`,
    setup(build) {
        build.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: loadSfc(path), loader: `ts` }));
    },
});
