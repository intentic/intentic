import type { QuietProbes } from "./quiet-watch.js";

export const quietProbesOf = (over: Partial<QuietProbes> = {}): QuietProbes => ({
    connected: () => 0,
    working: () => 0,
    terminalActivityAt: async () => 0,
    appsInUse: async () => false,
    nextWakeAt: async () => 0,
    keepAwake: async () => false,
    ...over,
});
