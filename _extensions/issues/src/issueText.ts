import type { IssueStatus, IssueSummary } from "@intentic/sandbox-contract";

/* The wording and the arithmetic the inbox reads by, kept out of the view so the judgments in it can be tested
 * without mounting anything. Every function here answers a question a person asks while scanning the list. */

export type Tone = `success` | `danger` | `warning` | `info` | `neutral` | `primary`;

/* HOW A ROW IS LABELLED. `open` deliberately carries no badge at all: it is the resting state of this list and
 * the majority of it, and a badge on every row is a badge nobody reads. What earns one is a row that is NOT
 * simply waiting. */
export const statusBadge = (status: IssueStatus): { label: string; tone: Tone } | undefined => {
    switch (status) {
        case `investigating`:
            return { label: `Being looked at`, tone: `primary` };
        case `resolved`:
            return { label: `Resolved`, tone: `success` };
        case `ignored`:
            return { label: `Ignored`, tone: `neutral` };
        case `open`:
            return undefined;
    }
};

/* WHETHER THIS ONE CAME BACK, which is the single most important thing this inbox can say and the thing a plain
 * status cannot: the daemon reopens a resolved group when it happens again and clears the run stamp with it, so
 * an `open` row that has already had a turn is a fix that did not hold. Worth a warning tone where a merely new
 * crash gets none. */
export const returned = (issue: IssueSummary): boolean => issue.status === `open` && (issue.runs?.length ?? 0) > 0;

/* HOW MUCH IT MATTERS, in the words somebody would use out loud. "1" is left as a bare number rather than
 * "once", because a column of counts is scanned rather than read, and the thousands separator is what makes the
 * difference between 900 and 9000 visible at a glance, which is the whole reason the number is on the row. */
export const timesWords = (count: number): string => (count === 1 ? `once` : `${count.toLocaleString()}×`);

/* THE ONE LINE UNDER THE TITLE: where it broke and what it broke in. The culprit first because it is the answer
 * to "is this mine or a library's", then the build, then the site. Anything absent is simply left out rather
 * than rendered as an em dash: a row of placeholders reads as missing data, and this data is genuinely optional.
 */
export const whereWords = (issue: IssueSummary): string =>
    [issue.culprit, issue.release === undefined ? undefined : `build ${issue.release}`, issue.origin]
        .filter((part) => part !== undefined)
        .join(` · `);

/* WHAT THE ROW'S PRIMARY BUTTON DOES. An issue nobody has looked at wants a turn started; one that is being
 * looked at already has a conversation to open instead, and offering to start a second turn on a bug an agent
 * is mid-way through fixing is how two worktrees end up on one file. */
export const primaryAction = (issue: IssueSummary): { kind: `investigate` } | { kind: `open`; conversationId: string } => {
    const latest = issue.runs?.at(-1);
    return issue.status === `investigating` && latest !== undefined
        ? { kind: `open`, conversationId: latest.conversationId }
        : { kind: `investigate` };
};

// The short reference a person can be given for their report ("we filed this as 4f3a1b2c"). Half the digest,
// which is plenty to find it again in a list this size and short enough to read out.
export const shortId = (id: string): string => id.slice(0, 8);
