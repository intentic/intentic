import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import type { Plugin, ResolvedConfig } from "vite";
import { shikiLangDeps } from "../../_tools/code-read/src/langs.ts";
import { sourceAliases } from "./source-aliases.ts";

/* Everything about building THIS SOURCE that holds whichever entry is being served, the app's own
 * (vite.config.ts), or the interactive demo's (`@intentic-dev/demo`, which reaches this through the package's
 * `./vite-shared` export). Only the entry, the base, the outDir and the dev server differ between them.
 *
 * Its own module rather than an export off vite.config.ts, because the demo importing that would pull the app's
 * dev-server block with it, including a readFileSync of a certificate the demo has no use for. */
/* THE ID OF THIS BUILD. One fresh value per build (and per dev-server start), read in the app via buildId()
 * (composables/buildEpoch.ts). It does two jobs, and the second is why it is a named export rather than an
 * expression inlined into `define` below:
 *
 *   1. it invalidates everything the browser persisted under the PREVIOUS build, so nobody has to remember to
 *      bump a schema number when a cached shape changes — every deploy is its own bump;
 *   2. it is written into `build.json` beside the bundle (vite.config.ts), which is how a tab that has been
 *      open for three days finds out a newer app has been deployed underneath it.
 *
 * The two MUST be the same value: the whole comparison is "what I am running" against "what is served", and
 * two calls to `Date.now()` a few milliseconds apart would make every freshly-loaded page believe it is stale. */
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

    /* Plain styles imported by lazy script modules (xterm, Vue Flow, the markdown editor) are not descendants
     * of styles.css, so pull their style modules directly. Relative imports resolve from the source file that
     * names them; package imports stay bare for Vite to resolve from the consuming app or demo. */
    for (const path of sourceFiles.filter((candidate) => /\.(?:ts|vue)$/.test(candidate))) {
        const source = readFileSync(path, `utf8`);
        for (const match of source.matchAll(/\bimport\s*(?:\(\s*)?["'`]([^"'`]+\.css)["'`]/g)) {
            const specifier = match[1]!;
            imports.set(specifier.startsWith(`.`) ? resolve(dirname(path), specifier) : specifier, path);
        }
    }

    /* Vite's dependency optimizer has already flattened every CSS import reachable from a package entry into
     * the generated dependency module. Monaco is the important case: importing its editor entry later would
     * otherwise append almost one hundred package styles at once. Discover the optimizer's CSS edges by shape
     * so any dependency with the same behavior joins the initial manifest without a package-specific list. */
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
        // SFC block tags are top-level. Anchoring avoids prose such as "the old <style scoped>" in a script
        // comment being mistaken for a block and shifting every real block's index.
        for (const match of source.matchAll(/^<style\b([^>]*)>/gm)) {
            const attributes = match[1] ?? ``;
            const lang = /\blang=["']([^"']+)["']/.exec(attributes)?.[1] ?? `css`;
            const scoped = /(?:^|\s)scoped(?:\s|=|$)/.test(attributes) ? `&scoped=${scope}` : ``;
            statements.push(`import ${JSON.stringify(`${path}?vue&type=style&index=${index}${scoped}&lang.${lang}`)};`);
            index += 1;
        }
    }
    statements.push(`export const installDevStyles = () => {};`);
    return statements.join(`\n`);
};

/* A production build extracts every lazy chunk's CSS into the initial sheet. Vite dev normally does the
 * opposite: the first visit to a lazy view appends one <style> per SFC, which makes Chrome DevTools rebuild the
 * selected element's Styles editor. Serve a style-only manifest before main evaluates so dev gets the same
 * stable stylesheet set without eagerly executing the route/editor modules themselves. */
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
        // Source-first workspace aliases, shared with vitest.config.ts, see source-aliases.ts for why.
        alias: sourceAliases(),
    },
    optimizeDeps: {
        // Shiki's core/engine/themes are statically imported by useHighlighter, so the dep optimizer finds
        // and pre-bundles them. The grammars, though, load via dynamic import from the source-linked ui lib,
        // which the optimizer leaves un-prebundled, it then serves 504 for every grammar chunk, so the
        // <Code> highlighter (and Monaco) silently fall back to unhighlighted text. Pre-bundle them all.
        // Vue Flow + dagre reach the graph the same way (lazy views importing DagGraph from the source-linked
        // ui lib), so they need the same treatment, and so does mermaid, which MermaidDiagram imports lazily
        // on the first document that holds a diagram, and which un-prebundled costs hundreds of separate
        // grammar requests before it draws anything.
        //
        // The names are resolved from the consuming config's `root`, which is why the demo package declares
        // these six itself: pnpm does not hoist, so its root cannot see what it never asked for.
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
