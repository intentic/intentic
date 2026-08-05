import { createRequire } from "node:module";

// The CLI's own version, read from its package.json (resolved relative to this module, so it works from
// dist/lib/version.js → ../../package.json). Surfaced in `intentic --version` and stamped into scaffolds +
// generated pipelines.
export const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
