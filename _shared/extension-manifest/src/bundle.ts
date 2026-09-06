/* WHAT A PUBLISHED BUNDLE MAY IMPORT, the loader's side of the manifest contract, stated where both sides can
 * read it. The host fetches an extension's entry bytes and imports them from a blob: URL, which has two hard
 * consequences: a relative import resolves against a blob: URL that was never created (a 404 for a file that
 * exists on disk), and a bare specifier resolves only if the shell's import map publishes it. Both failures are
 * invisible to the author, their own workspace loads the directory live, and fatal for every installer.
 *
 * It lives HERE, beside the manifest schema, because two independent judges have to agree on it: the daemon's
 * readiness check (before an author publishes) and the registry scanner (re-deriving the same answer cold, at
 * the pinned sha, every night). Two hand-rolled copies of this rule would drift exactly the way the manifest
 * schema and its published copy once did. */

// What the shell's import map publishes to a bundle (the web app's hostModules.ts is the runtime source of
// truth; its shim generator and this list are both asserted against the same module names).
export const HOST_PUBLISHED_SPECIFIERS = ["vue", "@intentic/extension-api", "@intentic/extension-ui", "@tanstack/vue-query"] as const;

// Every specifier a single-file ESM bundle names: static imports, re-exports, bare side-effect imports, and
// dynamic import(). A bundle is one file by contract, so a regex over its text is the right instrument, there
// is no module graph to walk.
export const bundleSpecifiers = (source: string): string[] => [
    ...new Set([
        ...[...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1] ?? ""),
        ...[...source.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu)].map((match) => match[1] ?? ""),
        ...[...source.matchAll(/(?:^|\n)\s*import\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1] ?? ""),
    ]),
];

/* Why this bundle cannot load, or undefined when it can. One sentence naming the offending specifiers, because
 * both callers surface it verbatim: the readiness row to the author, the registry facts to anyone browsing. */
export const bundleProblem = (source: string): string | undefined => {
    const specifiers = bundleSpecifiers(source);
    const relative = specifiers.filter((specifier) => specifier.startsWith(".") || specifier.startsWith("/"));
    if (relative.length > 0) {
        return `imports a second file (${relative.join(", ")}): a bundle is imported from a blob URL, so nothing relative to it can resolve`;
    }
    const published = new Set<string>(HOST_PUBLISHED_SPECIFIERS);
    const unpublished = specifiers.filter((specifier) => !published.has(specifier));
    if (unpublished.length > 0) {
        return `imports ${unpublished.join(", ")}, which the host does not publish, bundle it in, or use one of: ${HOST_PUBLISHED_SPECIFIERS.join(", ")}`;
    }
    return undefined;
};
