import { accountName, findOtherAccountAgents, otherAgentFix, otherAgentLine } from "../resident/other-accounts.js";
import type { UpkeepEntry } from "./entry.js";

/* ANOTHER ACCOUNT'S AGENT ON THIS COMPUTER (resident/other-accounts.ts says how one came to run). Each agent's upkeep
   finds the other, so whichever log a person reads names both, and `doctor` says so on demand. Reported, never
   stopped: which of the two is the one to keep is a person's call (each serves its own sandboxes), and the other
   account's files are not this agent's to change. */
const otherAccountAgent: UpkeepEntry = {
    id: "other-account-agent",
    kind: "agent",
    action: "report",
    reason: "a second intentic agent on this computer, run by another account",
    find: async () =>
        await Promise.all(
            (await findOtherAccountAgents()).map(async (agent) => {
                const account = await accountName(agent);
                return { what: `${agent.home}/.intentic/machine`, why: `${otherAgentLine(agent, account)}; keep one: ${otherAgentFix(agent, account)}` };
            }),
        ),
};

export const OTHER_ACCOUNT_ENTRIES: readonly UpkeepEntry[] = [otherAccountAgent];
