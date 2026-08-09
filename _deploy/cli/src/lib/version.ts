import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// The CLI's own version, read from its package.json — found by walking up to it, so the src (vitest) and
// compiled (shipped) layouts both resolve without either one knowing how deep this file sits. Surfaced in
// `intentic --version` and stamped into scaffolds + generated pipelines.
export const { version } = createRequire(import.meta.url)(join(packageRoot(import.meta.url), "package.json")) as { version: string };
