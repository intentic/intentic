import type { IssueStatus, IssueSummary } from "@intentic/sandbox-contract";

// Wording and arithmetic the inbox reads by, kept out of the view so it's testable without mounting anything.

export type Tone = `success` | `danger` | `warning` | `info` | `neutral` | `primary`;

// `open` carries no badge: it's the resting state and majority of the list. Only a row that is more than waiting earns
// one.
export const statusBadge = (status: IssueStatus): { label: string; tone: Tone } | undefined => {
    switch (status) {
        case `investigating`:
            return { label: `being looked at`, tone: `primary` };
        case `resolved`:
            return { label: `resolved`, tone: `success` };
        case `ignored`:
            return { label: `ignored`, tone: `neutral` };
        case `open`:
            return undefined;
    }
};

// True when an `open` row already has a run: the daemon reopens a resolved group on recurrence, so this marks a fix
// that didn't hold.
export const returned = (issue: IssueSummary): boolean => issue.status === `open` && (issue.runs?.length ?? 0) > 0;

// Count phrased the way someone would say it aloud; kept as a plain number above 1 so the thousands separator stays
// scannable.
export const timesWords = (count: number): string => (count === 1 ? `once` : `${count.toLocaleString()}×`);

// The line under the title: culprit, then build, then site, answering "is this mine or a library's" first. Missing
// fields are omitted, not shown as placeholders.
export const whereWords = (issue: IssueSummary): string =>
    [issue.culprit, issue.release === undefined ? undefined : `build ${issue.release}`, issue.origin]
        .filter((part) => part !== undefined)
        .join(` · `);

// Primary action per row: an unlooked-at issue offers to start a turn; one already being worked offers its existing run
// instead of a second one.
export const primaryAction = (issue: IssueSummary): { kind: `investigate` } | { kind: `open`; conversationId: string } => {
    const latest = issue.runs?.at(-1);
    return issue.status === `investigating` && latest !== undefined
        ? { kind: `open`, conversationId: latest.conversationId }
        : { kind: `investigate` };
};

// Short reference a person can quote back ("filed as 4f3a1b2c"); half the digest, plenty to find it again.
export const shortId = (id: string): string => id.slice(0, 8);
