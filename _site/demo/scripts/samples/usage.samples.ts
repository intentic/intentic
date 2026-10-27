import type { GroupSamples } from "./context.ts";

// The weekly reset is asked of the spent Pro account, then claimed on it.
export const usageSamples: GroupSamples<`usage`> = () => ({
    rollup: {},
    refreshPlanLimits: {},
    limitReset: { account: `acc_claude_demo_2` },
    claimLimitReset: { account: `acc_claude_demo_2` },
});
