import { createRequire } from "node:module";

// Resolved from the package's own manifest so it can never drift from what was published. The relative hop
// is the same from src and dist — both sit one level under the package root.
export const version: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
