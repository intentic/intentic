import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// Every suite here drives a real language server over a real program build — integration by the convention's
// own definition, and the reason this file used to carry a hand-set 20s ceiling. The unit project stays for
// whatever lands next that doesn't touch the machine.
export default defineConfig({
    test: {
        projects: [{ test: UNIT_SUITE }, { test: INTEGRATION_SUITE }],
    },
});
