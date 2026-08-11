import { defineConfig } from "vitest/config";

// Scoped to the package's own sources: the assembled engine tree (engine/, built by
// build-vscode-extension.sh) carries the daemon's test files on disk, and an unscoped run would sweep
// them up in a context where they cannot resolve.
export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
    },
});
