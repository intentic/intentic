import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        // The widget imports the contract for TYPES only, but vitest still resolves the specifier — and every
        // workspace package publishes its source behind this condition rather than a dist a fresh checkout has
        // never built.
        conditions: [`@intentic/src`],
    },
    test: {
        include: ["./src/**/*.test.ts"],
        // The element and identity suites need a DOM; the transport parser doesn't care, and one environment
        // for the package beats a per-file annotation.
        environment: "jsdom",
    },
});
