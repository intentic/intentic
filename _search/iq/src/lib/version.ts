import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// This package's own version, read from its manifest — found by walking up to it, so the src (vitest) and
// compiled (shipped) layouts both resolve without either one knowing how deep this file sits.
export const { version } = createRequire(import.meta.url)(join(packageRoot(import.meta.url), "package.json")) as { version: string };
