/* THE VIEWED PASS AT A HEADING'S SCOPE — the rules behind AgentReviewPanel's group tick (ReviewGroupCheck) and
 * its keyboard peer, ⇧V. See ReviewGroupCheck for why a reading tracker may be swept in bulk at all.
 *
 * These live out here rather than in the panel because each one is a DECISION with an edge that is easy to get
 * subtly wrong — what a second click does, what a half-read group says, where the cursor lands when the group
 * you just accepted was the last one — and inside a 900-line component none of the three could be stated, only
 * demonstrated by clicking.
 *
 * Every rule takes the rows the heading is CURRENTLY drawing. That is the whole scoping story: the panel passes
 * filtered, grouped rows, so standing in Code cannot tick a package's tests off, and with module grouping on the
 * unit is the package rather than the whole repo. */

// A row's identity in the viewed set is all any rule here needs, so it is all they ask for — the panel's
// AgentReviewFile satisfies this, and a test can state a group as three keys instead of three whole changes.
interface Keyed {
    readonly key: string;
}

// A group's progress, and the definition the other two rules and the heading itself all read from.
export const viewedIn = (rows: readonly Keyed[], viewed: ReadonlySet<string>): number => rows.filter((row) => viewed.has(row.key)).length;

/* What a click on the heading WRITES to every row under it. A partly-read group ticks the rest off; a fully-read
 * one un-ticks. That is the standard tri-state click, and the only reading under which the control is its own
 * undo — the alternative ("always tick") leaves a mis-click with no way back except N row clicks.
 *
 * An EMPTY group ticks on, which never reaches a user: a heading with no rows under it is not drawn. */
export const groupPassOn = (rows: readonly Keyed[], viewed: ReadonlySet<string>): boolean => viewedIn(rows, viewed) < rows.length;

/* A group's count, carrying its own progress: "3/12" mid-pass, the bare total otherwise. The list header states
 * the review's progress the same way (✓ 3/12), so one reading carries all the way down.
 *
 * A finished group says "12", not "12/12", because the tick beside it has already gone solid — the fraction is
 * there to answer "how far in am I", and at both ends of the pass that question is already answered. */
export const groupCountLabel = (rows: readonly Keyed[], viewed: ReadonlySet<string>): string => {
    const seen = viewedIn(rows, viewed);
    return seen === 0 || seen === rows.length ? `${rows.length}` : `${seen}/${rows.length}`;
};

/* Where ⇧V lands after accepting a group: the first visible row PAST the group's last one, so a pass over
 * packages is one key per package the way a pass over files is one key per file.
 *
 * Past the LAST row, not the first row after the selection — the group you just accepted is behind you in its
 * entirety, and landing back inside it would re-offer rows you just ticked.
 *
 * `undefined` means stay put, and it is the honest answer twice over: on the tail group there is nowhere after
 * it to go (clamped, not wrapped — wrapping to the top reads as having lost your place), and a group whose repo
 * is collapsed contributes no visible rows at all, so there is no row after it that would mean anything. */
export const rowAfterGroup = <T extends Keyed>(visible: readonly T[], rows: readonly Keyed[]): T | undefined => {
    const keys = new Set(rows.map((row) => row.key));
    const last = visible.findLastIndex((row) => keys.has(row.key));
    return last === -1 ? undefined : visible[last + 1];
};
