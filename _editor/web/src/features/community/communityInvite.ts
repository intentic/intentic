// WHEN THE EDITOR ASKS SOMEBODY TO JOIN THE COMMUNITY (2026-10-17). Once, after they have got somewhere, and never in
// the way of getting there. Two moments count as having got somewhere: the getting-started checklist settling its last
// step (the "You're set up" panel already opens itself then, so the ask rides along and adds nothing that interrupts),
// and, for whoever never meets that panel (put it away, or arrived with work already landed), coming back on a later
// day to a sandbox where their agents' work has landed. The second ask waits inside the account menu, behind a quiet dot
// on the avatar; nothing opens by itself. Whichever comes first is the only ask: once it has been in front of them it is
// not raised again, and a press on either answer (join, or not now) puts it away for good. The plain "Community on
// Discord" row stays in the account menu for anyone, asked or not.
//
// Kept per account in this browser, not with the sandbox: the ask is about the person, and one more browser asking once
// more is cheaper than a daemon route for it. A device key rather than an account key, so signing out and back in does
// not ask again.

// The record of one account's ask in this browser. Times are ms since the epoch.
export interface InviteRecord {
    // The first moment this browser saw the account past its first run (work landed, or a sandbox in use for a while).
    readonly engagedAt?: number;
    // The first moment the ask was in front of them: the finished checklist, or the account menu's note.
    readonly askedAt?: number;
    // What they answered. Either one ends the ask; the plain row stays.
    readonly closed?: InviteAnswer;
}

export type InviteAnswer = `joined` | `declined`;

// What the editor knows about the person in the sandbox open now.
export interface InviteFacts {
    // Whether they run this sandbox (maintainer and up): a viewer watching someone else's agents has not been through it.
    readonly canShip: boolean;
    // Agent work has reached this sandbox's workspace: they have been round the whole loop at least once.
    readonly landed: boolean;
    // The sandbox has agents older than its first days: a long-standing user, whether or not they land through review.
    readonly established: boolean;
}

// Where the ask, or the plain door, was met. Said to analytics so the two moments can be compared.
export type InvitePlace = `finished` | `menu-note` | `menu` | `phone-note` | `phone-menu` | `palette`;

const sameDay = (left: number, right: number): boolean => new Date(left).toDateString() === new Date(right).toDateString();

/** The record once these facts have been seen: the first engaged moment is written once and never moved. */
export const noteEngagement = (record: InviteRecord, facts: InviteFacts, now: number): InviteRecord =>
    record.engagedAt === undefined && facts.canShip && (facts.landed || facts.established) ? { ...record, engagedAt: now } : record;

/**
 * Whether the menu may ask: not answered yet, and either a long-standing sandbox or a later day than the one the work
 * first landed on. The day the loop is learned is left alone; the checklist's own finish covers that day.
 */
export const menuMayAsk = (record: InviteRecord, facts: InviteFacts, now: number): boolean => {
    if (record.closed !== undefined || !facts.canShip) {
        return false;
    }
    if (facts.established) {
        return true;
    }
    return record.engagedAt !== undefined && !sameDay(record.engagedAt, now);
};

/**
 * Whether the account menu draws the note. Only on the visit it was first seen on: a note that was read and left alone
 * goes back to being the plain row on the next page load, rather than sitting in the menu every time it is opened.
 */
export const noteShown = (record: InviteRecord, facts: InviteFacts, now: number, pageOpenedAt: number): boolean =>
    menuMayAsk(record, facts, now) && (record.askedAt === undefined || record.askedAt >= pageOpenedAt);

/** Whether the avatar wears the dot: there is an ask in the menu that has not been seen yet. */
export const dotShown = (record: InviteRecord, facts: InviteFacts, now: number): boolean =>
    menuMayAsk(record, facts, now) && record.askedAt === undefined;

/** Whether the finished checklist carries the ask: the moment is earned by finishing, so only an answer withholds it. */
export const finishedAsks = (record: InviteRecord): boolean => record.closed === undefined;

/** The record once the ask has been in front of them; only the first sighting is kept. */
export const markAsked = (record: InviteRecord, now: number): InviteRecord => (record.askedAt === undefined ? { ...record, askedAt: now } : record);

/** The record once they have answered. Joining from any door counts, so a person who found the row is not asked after. */
export const markAnswered = (record: InviteRecord, answer: InviteAnswer, now: number): InviteRecord =>
    record.closed === undefined ? { ...markAsked(record, now), closed: answer } : record;
