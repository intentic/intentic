/** Where the caller is: `import.meta.url`, `import.meta.dirname`, or any path. */
type Origin = string;

/**
 * The monorepo root, found by walking up from `from` until `pnpm-workspace.yaml` appears.
 * Throws if it never does — a wrong root is worse than a loud one.
 */
export declare const repoRoot: (from: Origin) => string;

/**
 * The calling package's own root — the directory of the first `package.json` at or above `from`.
 * Throws if there is none.
 */
export declare const packageRoot: (from: Origin) => string;
