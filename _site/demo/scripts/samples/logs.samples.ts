import type { GroupSamples } from "./context.ts";

// One caught error, as the editor batches what it saw.
export const logsSamples: GroupSamples<`logs`> = () => ({
    report: { events: [{ seenAt: 1_700_000_000_000, level: `error`, event: `vue.render`, message: `smoke` }] },
});
