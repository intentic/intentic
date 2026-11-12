import { bareBranch } from "../../../../models/fleet/presses/agentMenu";

// How a session name is shortened for the board card: `agent/` is dropped, and long names elide in the MIDDLE, never
// the end, since the head names the branch's purpose and the tail makes it unique. The budget (16) fits a drawn name
// (`otter-k7mq`) and a subagent's (`sub-otter-k7mq`), and cuts anything longer early rather than letting the chip
// crowd the card's row: a fix agent's `fix-intentic-jqzy27q_5` reads `fix-inte…zy27q_5`, its attempt still in sight.
// The full name still shows on hover, the agent's own page, and the card's copy menu.

const BUDGET = 16;
const HEAD = 8;
const TAIL = 7;

/** The branch as a board card spells it: no `agent/` prefix, and no longer than `BUDGET` with the middle elided. */
export const shortBranch = (branch: string): string => {
    const bare = bareBranch(branch);
    return bare.length <= BUDGET ? bare : `${bare.slice(0, HEAD)}…${bare.slice(-TAIL)}`;
};
