/* HOW A SESSION NAME IS SPELLED WHEN IT IS A LABEL RATHER THAN THE SUBJECT — the board card's copy of the
 * branch an isolated agent works on. Its own module rather than a computed inside <SessionChip>, for the reason
 * every other `*.ts` beside a `.vue` in this app exists: it is a pure string rule with edges worth a test, and a
 * rule that lives inside a component is a rule nobody can check.
 *
 * TWO THINGS MAKE THE WHOLE NAME WRONG ON A BOARD, and they are different problems with one answer.
 *
 *   · THE PREFIX IS THE MOST-PRINTED STRING IN THE PRODUCT AND THE LEAST INFORMATIVE. Every session branch
 *     opens `agent/`, so a lane of forty cards prints it forty times and distinguishes nothing by it.
 *   · THE NAMES ARE NOT ONE LENGTH. A branch named from the agent's own title runs about fifteen characters
 *     (`sharp-mesa-pj3v`); one raised from an outside id runs twice that (`ci-fix-32458072655-mt2mi4z21`). Down
 *     a lane that is a ragged column of mono text where every other card's second line is short.
 *
 * SO THE MIDDLE IS ELIDED, NEVER THE END. Both ends carry something and they carry different things: the head
 * says WHAT the branch is for, the tail is the part that makes it unique. Cutting the tail — which is what the
 * browser's own `truncate` does, and what this used to rely on alone — keeps the useless half of a long id and
 * throws away the half that identifies it, which is how two different agents come to show the same name.
 *
 * THE BUDGET IS CHOSEN OFF THE SHORT NAMES, not the long ones. Twenty characters is five more than an
 * app-generated name needs, so nothing this app names is ever elided and an ellipsis means "this name came
 * from somewhere else" rather than "your lane is narrow". Ten and nine either side: the tail is the
 * identifying half, so it is not the one that loses a character to the odd number.
 *
 * The full name is never lost — <SessionChip> hangs it on the label's hover, the agent's own page prints it
 * whole, and the card's right-click menu copies it. */

const PREFIX = `agent/`;
const BUDGET = 20;
const HEAD = 10;
const TAIL = 9;

/** The branch as a board card spells it: no `agent/`, and no longer than `BUDGET` with the middle elided. */
export const shortBranch = (branch: string): string => {
    const bare = branch.startsWith(PREFIX) ? branch.slice(PREFIX.length) : branch;
    return bare.length <= BUDGET ? bare : `${bare.slice(0, HEAD)}…${bare.slice(-TAIL)}`;
};
