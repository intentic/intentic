import { createRequire } from "node:module";

// The release flow bumps package versions before building the stable image, so this is the readable version
// behind registry.gitlab.com/radarsu/intentic/sandbox:stable.
export const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
