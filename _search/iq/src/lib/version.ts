import { createRequire } from "node:module";

// Resolved relative to this module so it works from dist/lib/version.js → ../../package.json.
export const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
