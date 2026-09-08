// How a session name is shortened for the board card: `agent/` is dropped, and long names elide in the MIDDLE, never
// the end, since the head names the branch's purpose and the tail makes it unique. Budget (20) exceeds any
// app-generated name, so only foreign names truncate; the full name still shows on hover, the agent's own page, and the
// card's copy menu.

const PREFIX = `agent/`;
const BUDGET = 20;
const HEAD = 10;
const TAIL = 9;

/** The branch as a board card spells it: no `agent/` prefix, and no longer than `BUDGET` with the middle elided. */
export const shortBranch = (branch: string): string => {
    const bare = branch.startsWith(PREFIX) ? branch.slice(PREFIX.length) : branch;
    return bare.length <= BUDGET ? bare : `${bare.slice(0, HEAD)}…${bare.slice(-TAIL)}`;
};
