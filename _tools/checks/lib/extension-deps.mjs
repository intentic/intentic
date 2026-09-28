// Which @intentic/* packages an extension's manifest may name, and the findings for one manifest. The same list as the
// `_extensions/**` no-restricted-imports override in .oxlintrc.json, which holds the imports (extension-deps.test.mjs
// keeps the two in step): the extension SDK, what it declares, the wire contract, and @intentic/base, which has no
// dependencies of its own and which extension-manifest itself stands on.
export const SHIPPED = [
    "@intentic/base",
    "@intentic/connector-runtime",
    "@intentic/extension-api",
    "@intentic/extension-manifest",
    "@intentic/extension-ui",
    "@intentic/sandbox-contract",
];

// What a build or a suite stands on and nothing ships: the test kit and the shared compiler settings.
export const BUILD_ONLY = ["@intentic/testing", "@intentic/tsconfig"];

// Each dependency field, and what it may name. An optional dependency is installed with the extension like any other.
export const ALLOWED = {
    dependencies: new Set(SHIPPED),
    peerDependencies: new Set(SHIPPED),
    optionalDependencies: new Set(SHIPPED),
    devDependencies: new Set([...SHIPPED, ...BUILD_ONLY]),
};

const SCOPE = "@intentic/";

// The 1-based line naming `dep` inside `field`'s block, or the field's own line when the name is not found after it.
const lineOf = (lines, field, dep) => {
    const opens = lines.findIndex((text) => text.includes(`"${field}"`));
    const named = lines.findIndex((text, at) => at > opens && text.includes(`"${dep}"`));
    return (named === -1 ? opens : named) + 1;
};

/** `path:line` findings for one extension manifest's text: every @intentic/* name a field may not hold. */
export const manifestFindings = (path, text) => {
    const manifest = JSON.parse(text);
    const lines = text.split("\n");
    return Object.entries(ALLOWED).flatMap(([field, allowed]) =>
        Object.keys(manifest[field] ?? {})
            .filter((dep) => dep.startsWith(SCOPE) && !allowed.has(dep))
            .sort()
            .map((dep) => `${path}:${lineOf(lines, field, dep)} ${manifest.name} names ${dep} in ${field}`),
    );
};
