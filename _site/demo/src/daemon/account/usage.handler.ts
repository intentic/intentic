import { demoUsageRollup } from "../../fixture/sandbox";
import { roster, STARTED_AT } from "../board/roster";
import { claimLimitReset, limitResetStatus } from "./signIns";
import type { Doors } from "../doors";

export const usageDoors = {
    rollup: () => ({
        rows: demoUsageRollup(
            STARTED_AT,
            (model) => roster.agents.filter((agent) => agent.startedBy?.startsWith(`agent:`) !== true && agent.model === model).map((agent) => agent.id),
        ),
    }),
    // What every connection read posts, on arrival and on the rail's refresh control alike. Nothing held: every demo
    // reading is taken, so the press moves the age rather than explaining why it couldn't.
    refreshPlanLimits: () => ({ ok: true, held: [] }),
    // The weekly session reset, once per account: the chat's Continue strip offers it on a refused turn.
    limitReset: ({ account }) => limitResetStatus(account),
    claimLimitReset: ({ account }) => claimLimitReset(account),
} satisfies Doors<`usage`>;
