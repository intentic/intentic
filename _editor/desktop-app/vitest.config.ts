import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

/* The launcher's own suite, and it covers exactly one kind of thing: the PURE readings of what the installer
 * says (src/desktop.ts, src/setupPlan.ts).
 *
 * That is not an arbitrary line. Everything else in this package is either a Tauri command: a one-line
 * `invoke` whose behaviour is entirely on the Rust side, which has its own suite, or a Vue template whose
 * value is what it looks like on a real Windows screen. What sits between them is a set of parsers and a
 * progress model that decide whether a stopped install reports anything at all, and those are ordinary
 * functions over strings.
 *
 * They earned a suite the hard way: a Windows install reported four specific things wrong with the machine,
 * exited, and the window showed a spinner. Every line of that diagnosis went past code in here.
 */
export default defineConfig({
    test: {
        projects: [{ test: UNIT_SUITE }, { test: INTEGRATION_SUITE }],
    },
});
