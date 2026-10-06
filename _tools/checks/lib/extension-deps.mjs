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

const EXTENSION = /^@intentic\/ext-[^/]+$/;

// Outside _extensions, the packages that may depend on an extension at all, and through which import specifiers. An
// extension is the end of the line: it stands on the SDK and nothing stands on it, apart from these two. The web app
// compiles the UI extensions into its bundle (_editor/web/src/extension-host/builtins.ts), so it may name any of them.
// The desktop app's files sidecar runs ONLYOFFICE's browser engine for folders on the user's own disk, with no sandbox,
// through the one entry the extension exports for it: the engine is the extension's (about 3,000 lines it also runs in
// a sandbox), so it stays there, and this keeps a second host from reaching past that entry or a third from appearing.
export const CONSUMERS = new Map([
    ["_editor/web", { extensions: undefined, specifiers: undefined }],
    ["_devices/local-files", { extensions: new Set(["@intentic/ext-onlyoffice"]), specifiers: new Set(["@intentic/ext-onlyoffice/local-office"]) }],
]);

/** `path:line` findings for a manifest outside _extensions: every extension it names that CONSUMERS does not allow it. */
export const consumerFindings = (path, text, dir = path.replace(/\/package\.json$/, "")) => {
    const manifest = JSON.parse(text);
    const lines = text.split("\n");
    const allowed = CONSUMERS.get(dir);
    return Object.keys(ALLOWED).flatMap((field) =>
        Object.keys(manifest[field] ?? {})
            .filter((dep) => EXTENSION.test(dep) && (allowed === undefined || (allowed.extensions !== undefined && !allowed.extensions.has(dep))))
            .sort()
            .map((dep) => `${path}:${lineOf(lines, field, dep)} ${manifest.name} names the extension ${dep} in ${field}`),
    );
};

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](@intentic\/ext-[^"']+)["']/g;

/** `path:line` findings for a source file of a CONSUMERS package: every extension specifier outside its allowed set. */
export const specifierFindings = (path, text, specifiers) =>
    text
        .split("\n")
        .flatMap((line, at) =>
            [...line.matchAll(SPECIFIER)].filter((match) => !specifiers.has(match[1])).map((match) => `${path}:${at + 1} imports ${match[1]}`),
        );
