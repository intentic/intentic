import { cliPartsFake } from "../vendor-cli/vendor-cli.testing.js";
import type { GrokSlice } from "./grok-provider.js";

// Grok's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const grokSliceFake = () =>
    ({
        async *grokAgent() {
            yield { kind: "done" };
        },
        // Nothing signed in to Grok Build: nothing guards on it, so the honest default is unset up.
        grokBuild: cliPartsFake("Grok Build's default"),
    }) satisfies GrokSlice;
