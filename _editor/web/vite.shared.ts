import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "@intentic/constants/node";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defaultClientConditions, type Plugin, type ResolvedConfig } from "vite";
import { shikiLangDeps } from "../../_tools/code-read/src/langs.ts";
import { sourceAliases } from "./source-aliases.ts";

// Config shared between the app's own build (vite.config.ts) and the interactive demo's (@intentic/demo, via its
// ./vite-shared export); only entry, base, outDir and dev server differ. Its own module, not an export off
// vite.config.ts, so the demo importing it doesn't also pull in the dev-server's certificate reads.
// One fresh value per build; used for cache invalidation and build.json's staleness check, computed once only.
export const BUILD_ID = String(Date.now());
// The commit the build was made from, so a client report names the code the page ran and not only when it was built.
// Null where git cannot say (a build from an exported tree, no git on PATH); the report then goes without it.
export const BUILD_COMMIT = ((): string | null => {
    try {
        const sha = execFileSync(`git`, [`rev-parse`, `--short`, `HEAD`], {
            cwd: import.meta.dirname,
            encoding: `utf8`,
            stdio: [`ignore`, `pipe`, `ignore`],
        }).trim();
        return sha === `` ? null : sha;
    } catch {
        // allow(silent-catch): no git on PATH, or a tree exported without one, is a build with no commit to name
        return null;
    }
})();

const DEV_STYLES = `virtual:intentic-dev-styles`;
const RESOLVED_DEV_STYLES = `\0${DEV_STYLES}`;
const sourceRoots = [
    fileURLToPath(new URL(`./src`, import.meta.url)),
    fileURLToPath(new URL(`../ui/src`, import.meta.url)),
    fileURLToPath(new URL(`../../_extensions`, import.meta.url)),
];

const filesBelow = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(root, entry.name);
        return entry.isDirectory() ? filesBelow(path) : [path];
    });

const devStyleSource = async (
    config: ResolvedConfig,
    resolveImport: (id: string, importer: string) => Promise<string | undefined>,
): Promise<string> => {
    const mainStyle = fileURLToPath(new URL(`./src/styles.css`, import.meta.url));
    const imports = new Map<string, string>([[mainStyle, mainStyle]]);
    const sourceFiles = sourceRoots.flatMap(filesBelow).filter((path) => !/\.(?:test|spec)\./.test(path));

    // Plain style imports (xterm, Vue Flow, markdown editor) aren't reachable from styles.css; pulled directly here.
    for (const path of sourceFiles.filter((candidate) => /\.(?:ts|vue)$/.test(candidate))) {
        const source = readFileSync(path, `utf8`);
        for (const match of source.matchAll(/\bimport\s*(?:\(\s*)?["'`]([^"'`]+\.css)["'`]/g)) {
            const specifier = match[1]!;
            imports.set(specifier.startsWith(`.`) ? resolve(dirname(path), specifier) : specifier, path);
        }
    }

    // Mirrors Vite's optimizer, which already flattens CSS reachable from a package entry (Monaco: ~100 styles).
    const optimized = resolve(config.cacheDir, `deps`);
    if (existsSync(optimized)) {
        for (const path of filesBelow(optimized).filter((candidate) => candidate.endsWith(`.js`))) {
            const source = readFileSync(path, `utf8`);
            for (const match of source.matchAll(/^\s*import\s*["']([^"']+\.css(?:\?[^"']*)?)["'];?/gm)) {
                imports.set(match[1]!, path);
            }
        }
    }

    const resolvedImports = await Promise.all(
        [...imports].map(async ([id, importer]) => (id.startsWith(`/`) ? id : ((await resolveImport(id, importer)) ?? id))),
    );
    const statements = resolvedImports.map((path) => `import ${JSON.stringify(path)};`);
    for (const path of sourceFiles.filter((candidate) => candidate.endsWith(`.vue`))) {
        const source = readFileSync(path, `utf8`);
        const normalized = relative(config.root, path).replaceAll(`\\`, `/`);
        const scope = createHash(`sha256`).update(normalized).digest(`hex`).slice(0, 8);
        let index = 0;
        // Anchored to line starts, so comment prose like "<style scoped>" can't be mistaken for a real block.
        for (const match of source.matchAll(/^<style\b([^>]*)>/gm)) {
            const attributes = match[1] ?? ``;
            const lang = /\blang=["']([^"']+)["']/.exec(attributes)?.[1] ?? `css`;
            const scoped = /(?:^|\s)scoped(?:\s|=|$)/.test(attributes) ? `&scoped=${scope}` : ``;
            statements.push(`import ${JSON.stringify(`${path}?vue&type=style&index=${index}${scoped}&lang.${lang}`)};`);
            index += 1;
        }
    }
    // Drops identical style rewrites Tailwind re-pushes on every save (lib/styleStability.ts).
    statements.push(`import { stabilizeStyleWrites } from "@intentic/ui/style-stability";`);
    statements.push(`export const installDevStyles = () => stabilizeStyleWrites("style[data-vite-dev-id]");`);
    return statements.join(`\n`);
};

// Dev normally appends one <style> per SFC on first visit to a lazy view, resetting DevTools' Styles editor; this
// serves a stable style-only manifest upfront instead, mirroring how a production build inlines lazy CSS.
const stableDevStyles = (): Plugin => {
    let config: ResolvedConfig;
    return {
        name: `intentic-stable-dev-styles`,
        configResolved(resolved) {
            config = resolved;
        },
        resolveId(id) {
            return id === DEV_STYLES ? RESOLVED_DEV_STYLES : undefined;
        },
        async load(id) {
            if (id !== RESOLVED_DEV_STYLES) {
                return undefined;
            }
            return config.command === `serve`
                ? devStyleSource(config, async (specifier, importer) => (await this.resolve(specifier, importer, { skipSelf: true }))?.id)
                : `export const installDevStyles = () => {};`;
        },
    };
};

// SERVE ONLY: which checkout this dev server serves, and which Intentic conversation started it. The editor mirrors the
// owner's own dev servers onto 47145 and 47146 inside the sandbox, so a page on those ports can be the owner's code
// rather than the worktree an agent just edited; the editor's `editor_build` agent tool (src/shell/agentDevTools.ts)
// reports this so the agent can tell. Every conversation sees its own worktree at the same path, so the path alone
// can't say whose it is: the branch and the starting conversation can. A production build never carries it.
const devSource = (): Plugin => ({
    name: `intentic-dev-source`,
    apply: `serve`,
    config: () => {
        const root = repoRoot(import.meta.url);
        let branch: string | null = null;
        try {
            branch = execFileSync(`git`, [`-C`, root, `branch`, `--show-current`], { encoding: `utf8`, stdio: [`ignore`, `pipe`, `ignore`] }).trim() || null;
        } catch {
            // allow(silent-catch): not a git checkout, or no git; the branch stays null, which the tool reports as unknown.
        }
        const source = { root, branch, startedBy: process.env[`INTENTIC_TURN_OWNER`] ?? null, startedAt: new Date().toISOString() };
        return { define: { "import.meta.env.DEV_SOURCE": JSON.stringify(source) } };
    },
});

// SERVE ONLY: the project's JSON as one compact `JSON.parse` with no sourcemap. Vite serves a JSON import as a module its
// own JSON plugin writes, last of all plugins, with no map, so the dev server then attaches a fallback map that carries
// the whole module again, base64 and token by token: the app's English catalog came to 3.3-5 MB per reload, most of it a
// map leading from a string back to the same text, which no debugger has any use for. Written here instead (`load`, as a
// JS module, with an explicitly empty map, which is what tells the server to attach none), it is 0.6 MB: the file
// minus its indentation. The module keeps the file's own id, so an edit invalidates and reloads exactly as before. A
// query (`?raw`, `?url`, `?inline`) and anything under node_modules are left to Vite, and so is a file that does not
// parse, so its error reads as it always has.
const compactDevJson = (): Plugin => ({
    name: `intentic-compact-dev-json`,
    apply: `serve`,
    enforce: `pre`,
    load(id) {
        const file = /^([^?]+\.json)(?:\?import)?$/.exec(id)?.[1];
        if (file === undefined || file.includes(`/node_modules/`)) {
            return undefined;
        }
        let text: string;
        try {
            text = JSON.stringify(JSON.parse(readFileSync(file, `utf8`)));
        } catch {
            // allow(silent-catch): Vite reads the file itself and reports the parse error in its own words.
            return undefined;
        }
        return { code: `export default JSON.parse(${JSON.stringify(text)});`, moduleType: `js`, map: { mappings: `` } };
    },
});

export const MONACO_WORKER = `monaco-editor-core/esm/vs/editor/editor.worker.start.js`;

export const shared = {
    plugins: [vue(), tailwindcss(), stableDevStyles(), devSource(), compactDevJson()],
    // Every JSON import as one `JSON.parse` of a string, not an object literal with a named export per top-level key.
    // The app's English catalog is 0.75 MB: as 26 named exports it was a 3.25 MB module in dev (the literal plus an
    // inline sourcemap of it) on every reload, and an object literal is slower to parse than JSON in production too.
    // Nothing imports a JSON file's keys by name, which is all `namedExports: false` gives up; both flags are needed,
    // since Vite keeps the named exports (and the literal) while `namedExports` is on.
    json: { namedExports: false, stringify: true },
    // ES workers, since the code highlighter's worker (ui/src/markdown/highlightWorker.ts) loads each grammar as its
    // own chunk on first use, which an IIFE worker cannot split.
    worker: { format: `es` as const },
    define: { "import.meta.env.BUILD_ID": JSON.stringify(BUILD_ID), "import.meta.env.BUILD_COMMIT": JSON.stringify(BUILD_COMMIT) },
    resolve: {
        // Source-first workspace aliases shared with bun.setup.ts; see source-aliases.ts.
        alias: sourceAliases(),
        // Every other workspace library at the source its `@intentic/src` export condition names, as tsc reads it
        // (tsconfig.base.json's customConditions) and the site's build does. Through a library's `dist` a build is only
        // as fresh as whatever last compiled it: CI's self-hosted runners keep `dist` between jobs, the desktop job
        // builds no library first, and run 38135375327 failed on exports _tools/constants/dist did not have yet.
        conditions: [`@intentic/src`, ...defaultClientConditions],
    },
    optimizeDeps: {
        // Pre-bundled since each loads via dynamic import from the source-linked ui lib, which the dep optimizer
        // otherwise leaves un-prebundled, so requests 404/504 and highlighting or diagrams silently fail.
        // - shiki/core, shiki/engine/javascript, @shikijs/themes/*, shikiLangDeps: useHighlighter, <Code>, Monaco.
        // - @vue-flow/core, @dagrejs/dagre: DagGraph, lazily imported by graph views.
        // - mermaid: MermaidDiagram, lazily imported on the first document with a diagram.
        // - monaco's editor.worker.start.js: the editor worker's own entry (editorWorker.ts), found only when the first
        //   editor spawns it, which re-optimised and reloaded the dev page under whoever opened a diff first. The demo
        //   names it through @intentic/web instead (MONACO_WORKER), having no monaco of its own.
        // Resolved from the consuming config's root, which is why the demo package repeats this list itself; pnpm
        // doesn't hoist, so its root can't see what it never asked for.
        include: [
            `shiki/core`,
            `shiki/engine/javascript`,
            `@shikijs/themes/light-plus`,
            `@shikijs/themes/dark-plus`,
            `@vue-flow/core`,
            `@dagrejs/dagre`,
            `mermaid`,
            MONACO_WORKER,
            ...shikiLangDeps,
        ],
    },
};
