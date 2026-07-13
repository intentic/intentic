import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
        // A cold nodenext program build for the cross-file rename runs ~5s on a loaded CI runner; give it headroom.
        testTimeout: 20000,
    },
});
