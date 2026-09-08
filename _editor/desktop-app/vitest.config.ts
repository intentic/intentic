import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// Covers only the pure parsers over installer output (src/desktop.ts, src/setupPlan.ts) — plain functions over
// strings. Tauri commands have their own Rust suite; the Vue templates are judged by eye.
export default defineConfig({
    test: {
        projects: [{ test: UNIT_SUITE }, { test: INTEGRATION_SUITE }],
    },
});
