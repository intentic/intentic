import type { GroupSamples } from "./context.ts";

export const auditSamples: GroupSamples<`audit`> = () => ({
    list: { limit: 100 },
    verify: undefined,
    status: undefined,
    export: { from: 0, to: Date.now() },
});
