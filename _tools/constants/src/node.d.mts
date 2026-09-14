/** Where the caller is: `import.meta.url`, `import.meta.dirname`, or any path. */
type Origin = string;

/** The monorepo root, found by walking up from `from` until `pnpm-workspace.yaml` appears. */
export declare const repoRoot: (from: Origin) => string;

/** The calling package's own root — the directory of the first `package.json` at or above `from`. */
export declare const packageRoot: (from: Origin) => string;
