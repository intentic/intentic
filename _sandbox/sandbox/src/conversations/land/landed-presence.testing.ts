import type { LandedPresences } from "./landed-presence.js";

// A landed-presence probe that never finds anything missing, and so never names anyone: the one stand-in for suites
// whose land never reaches git (landed-presence.integration.test.ts derives the real one).
export const noPresences = (): LandedPresences => ({
    of: () => undefined,
    note: () => {},
    refresh: async () => false,
    measured: () => false,
    forget: () => {},
    metrics: () => ({}),
});
