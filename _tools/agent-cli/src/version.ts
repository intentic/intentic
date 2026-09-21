// A package's own version, read from its manifest.
import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

/**
 * The caller's own published version, found by walking up to its manifest rather than by counting `../..`, so
 * the src layout (vitest), the dist layout (shipped) and a file that later moves a directory all resolve alike.
 */
export const packageVersion = (from: string): string => (createRequire(from)(join(packageRoot(from), "package.json")) as { version: string }).version;
