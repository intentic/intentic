import type { GroupSamples } from "./context.ts";

export const choresSamples: GroupSamples<`chores`> = ({ now }) => ({
    list: undefined,
    record: { repo: `web`, chore: `audit`, ranAt: now, runId: `smoke`, outcome: `clean`, digest: `smoke` },
    probe: { repo: `web`, id: `audit` },
});
