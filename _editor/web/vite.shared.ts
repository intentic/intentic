import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import type { Plugin, ResolvedConfig } from "vite";
import { shikiLangDeps } from "../../_tools/code-read/src/langs.ts";
import { sourceAliases } from "./source-aliases.ts";

// Config shared between the app's own build (vite.config.ts) and the interactive demo's (@intentic/demo, via its
// ./vite-shared export); only entry, base, outDir and dev server differ. Its own module, not an export off
// vite.config.ts, so the demo importing it doesn't also pull in the dev-server's certificate reads.
// One fresh value per build; used for cache invalidation and build.json's staleness check, computed once only.
export const BUILD_ID = String(Date.now());

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

export const shared = {
    plugins: [vue(), tailwindcss(), stableDevStyles()],
    define: { "import.meta.env.BUILD_ID": JSON.stringify(BUILD_ID) },
    resolve: {
        // Source-first workspace aliases shared with vitest.config.ts; see source-aliases.ts.
        alias: sourceAliases(),
    },
    optimizeDeps: {
        // Pre-bundled since each loads via dynamic import from the source-linked ui lib, which the dep optimizer
        // otherwise leaves un-prebundled, so requests 404/504 and highlighting or diagrams silently fail.
        // - shiki/core, shiki/engine/javascript, @shikijs/themes/*, shikiLangDeps: useHighlighter, <Code>, Monaco.
        // - @vue-flow/core, @dagrejs/dagre: DagGraph, lazily imported by graph views.
        // - mermaid: MermaidDiagram, lazily imported on the first document with a diagram.
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
            ...shikiLangDeps,
        ],
    },
};
