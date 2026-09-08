// Rules behind AgentReviewPanel's group tick (ReviewGroupCheck) and its keyboard peer, Shift+V, kept out of the
// panel since each is an easy-to-get-wrong decision. Every rule takes only the rows the heading is currently
// drawing (filtered, grouped), so a package's tests are never ticked while standing in Code.

// Structural: the panel's AgentReviewFile satisfies this, so a test can state a group as bare keys.
interface Keyed {
    readonly key: string;
}

// A group's progress; the shared definition the other rules and the heading label read from.
export const viewedIn = (rows: readonly Keyed[], viewed: ReadonlySet<string>): number => rows.filter((row) => viewed.has(row.key)).length;

// True while any row in the group is unviewed; click ticks the rest on and un-ticks a full group. An empty group
// ticks on but is never rendered.
export const groupPassOn = (rows: readonly Keyed[], viewed: ReadonlySet<string>): boolean => viewedIn(rows, viewed) < rows.length;

// Group's progress label: "seen/total" mid-pass, the bare total at either end, matching the list header's own
// reading.
export const groupCountLabel = (rows: readonly Keyed[], viewed: ReadonlySet<string>): string => {
    const seen = viewedIn(rows, viewed);
    return seen === 0 || seen === rows.length ? `${rows.length}` : `${seen}/${rows.length}`;
};

// First visible row past the group's last row, so accepted rows are never re-offered. Undefined for the tail
// group or a fully collapsed group: neither has a next row.
export const rowAfterGroup = <T extends Keyed>(visible: readonly T[], rows: readonly Keyed[]): T | undefined => {
    const keys = new Set(rows.map((row) => row.key));
    const last = visible.findLastIndex((row) => keys.has(row.key));
    return last === -1 ? undefined : visible[last + 1];
};
