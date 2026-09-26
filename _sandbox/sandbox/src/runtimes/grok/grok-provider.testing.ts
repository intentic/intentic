import type { GrokSlice } from "./grok-provider.js";

// Grok's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const grokSliceFake = () =>
    ({
        async *grokAgent() {
            yield { kind: "done" };
        },
    }) satisfies GrokSlice;
