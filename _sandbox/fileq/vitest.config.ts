import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

/* The unit suite is pure in-memory transforms (front matter, format tables, budget clipping); the integration
 * suite builds real fixture files (zips that are docx/pptx, an exceljs-written xlsx, hand-written PDF bytes)
 * in temp trees and drives the derivers and the CLI against them — machine work, so it gets the integration
 * budget from the shared config. */
export default defineConfig({
    test: {
        projects: [{ test: UNIT_SUITE }, { test: INTEGRATION_SUITE }],
    },
});
