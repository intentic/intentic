// What a published bundle may import. The host imports an extension's entry bytes from a blob: URL, so a relative
// import can never resolve and a bare specifier resolves only if the shell's import map publishes it. Lives here
// because both the daemon's readiness check and the registry scanner judge a bundle against this same rule.

// What the shell's import map publishes to a bundle.
export const HOST_PUBLISHED_SPECIFIERS = ["vue", "@intentic/extension-api", "@intentic/extension-ui", "@tanstack/vue-query"] as const;

// Every specifier a single-file ESM bundle names: static imports, re-exports, bare side-effect imports, dynamic
// import(). A regex is enough since a bundle is one file by contract.
export const bundleSpecifiers = (source: string): string[] => [
    ...new Set([
        ...[...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1] ?? ""),
        ...[...source.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu)].map((match) => match[1] ?? ""),
        ...[...source.matchAll(/(?:^|\n)\s*import\s*["'`]([^"'`]+)["'`]/gu)].map((match) => match[1] ?? ""),
    ]),
];

// Why this bundle cannot load, or undefined when it can, naming the offending specifiers.
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
