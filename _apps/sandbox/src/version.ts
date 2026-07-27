import { createRequire } from "node:module";

// The release flow bumps package versions before building the stable image, so this is the readable version
// behind registry.gitlab.com/radarsu/intentic/sandbox:stable.
export const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// Only semantic-release's prepareCmd stamps a real version into package.json; everything built from a working
// tree (local `pnpm dev`, the CI sha-/latest images) keeps the repo's unpublished 0.0.0 sentinel. That sentinel
// is the daemon's "I am not a release" signal: its @intentic/* packages aren't on npm (see ensure-intent's
// dependencySpec) and it has no release version to compare against (see platform/version-check.ts).
export const isDevBuild = version === "0.0.0";
