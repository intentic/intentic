import type {
    S2sGrants,
    S2sGrantsUpdate,
    S2sContact,
    S2sContactNotice,
    S2sContactTask,
    S2sOutboxEntry,
    S2sThreadMessage,
    S2sThreadsList,
    S2sThreadSummary,
} from "@intentic/sandbox-contract/schemas/s2s";

// What the Messages tab draws, worked out from what the daemon answers, with nothing of Vue in it: the tab's badge, the
// order threads and contacts are listed in, a thread's messages in days, and a fingerprint in groups a person can read
// aloud. Pure, so each rule is tested by value (messagesView.test.ts).

/** Threads with something unread in them: what the tab's badge and the sandbox's attention count, not the messages. */
export const unreadThreads = (threads: readonly S2sThreadSummary[]): number => threads.filter((thread) => thread.unread > 0).length;

/** Tasks contacts handed this sandbox that wait for the owner's Allow, oldest first: the longest kept waiting leads. */
export const waitingTasks = (tasks: readonly S2sContactTask[]): S2sContactTask[] =>
    tasks.filter((task) => task.state === `held`).toSorted((a, b) => a.askedAt - b.askedAt);

/** The Contacts part's badge: contact requests waiting on a person here, and contact tasks waiting for the owner. */
export const contactsBadge = (requests: number, tasks: readonly S2sContactTask[]): number => requests + waitingTasks(tasks).length;

/** The tab's badge: threads with something unread, contact requests waiting on a person here, and contact tasks waiting. */
export const messagesBadge = (list: S2sThreadsList | undefined, tasks: readonly S2sContactTask[] = []): number =>
    (list === undefined ? 0 : unreadThreads(list.threads)) + contactsBadge(list?.requests ?? 0, tasks);

// A contact's tasks in the order a person reads them: what waits on them first, then what runs, then what settled, each
// newest first.
const rankOf = (task: S2sContactTask): number => (task.state === `held` ? 0 : task.state === `running` ? 1 : 2);
export const tasksOfContact = (tasks: readonly S2sContactTask[], contact: string): S2sContactTask[] =>
    tasks.filter((task) => task.contact === contact).toSorted((a, b) => rankOf(a) - rankOf(b) || b.askedAt - a.askedAt);

/** What a task is called on its row: its title, or the first line of its words; undefined when it carries neither. */
export const taskName = (task: S2sContactTask): string | undefined => {
    const title = task.title?.trim();
    if (title !== undefined && title !== ``) {
        return title;
    }
    const line = task.task
        ?.split(`\n`)
        .map((each) => each.trim())
        .find((each) => each !== ``);
    return line === undefined ? undefined : line.length > TASK_NAME_MAX ? `${line.slice(0, TASK_NAME_MAX - 1)}…` : line;
};
const TASK_NAME_MAX = 120;

/** Newest first, by the last thing that happened in each. */
export const threadsInOrder = (threads: readonly S2sThreadSummary[]): S2sThreadSummary[] => threads.toSorted((a, b) => b.last.at - a.last.at);

/** When a message happened, for the order it is read in: when it arrived here, or, for one sent, when it was sent. */
const momentOf = (message: S2sThreadMessage): number => message.receivedAt ?? message.sentAt;

export interface MessageDay {
    /** Midnight of the day, local time: the key, and what the heading is written from. */
    readonly day: number;
    readonly messages: readonly S2sThreadMessage[];
    /** Per message: whether it opens a run from one side, so the run's sender is said once. */
    readonly opens: readonly boolean[];
}

const midnight = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

/**
 * A thread's messages oldest first, in days, each day's messages in the order they happened; a message from the same
 * side as the one before it, within ten minutes, continues that run rather than naming its sender again.
 */
export const threadDays = (messages: readonly S2sThreadMessage[]): MessageDay[] => {
    const ordered = messages.toSorted((a, b) => momentOf(a) - momentOf(b));
    const days: { day: number; messages: S2sThreadMessage[]; opens: boolean[] }[] = [];
    let previous: S2sThreadMessage | undefined;
    for (const message of ordered) {
        const day = midnight(momentOf(message));
        let current = days.at(-1);
        if (current?.day !== day) {
            current = { day, messages: [], opens: [] };
            days.push(current);
            previous = undefined;
        }
        const continues = previous !== undefined && previous.direction === message.direction && momentOf(message) - momentOf(previous) < RUN_GAP_MS;
        current.messages.push(message);
        current.opens.push(!continues);
        previous = message;
    }
    return days;
};
const RUN_GAP_MS = 10 * 60_000;

/** The thread's received messages not yet read: what opening it marks read. */
export const hasUnread = (messages: readonly S2sThreadMessage[]): boolean => messages.some((message) => message.direction === `in` && !message.read);

/** How a sent message stands, as the mark under it says: the daemon's own state, or none for one received. */
export type DeliveryMark = `queued` | `sent` | `undelivered` | undefined;
export const deliveryMark = (message: S2sThreadMessage): DeliveryMark => (message.direction === `out` ? (message.delivery?.state ?? `sent`) : undefined);

/** What the outbox's quiet line says: how many wait, and the one reason the oldest gave, if it gave one. */
export interface OutboxLine {
    readonly waiting: number;
    readonly undelivered: number;
    readonly reason: string | undefined;
    readonly next: number | undefined;
}
export const outboxLine = (entries: readonly S2sOutboxEntry[]): OutboxLine | undefined => {
    const waiting = entries.filter((entry) => entry.state === `waiting`).toSorted((a, b) => a.firstAt - b.firstAt);
    const undelivered = entries.length - waiting.length;
    if (waiting.length === 0 && undelivered === 0) {
        return undefined;
    }
    const reason = waiting[0]?.lastError;
    const next = waiting.map((entry) => entry.nextAt).filter((at) => at !== undefined);
    return { waiting: waiting.length, undelivered, reason, next: next.length === 0 ? undefined : Math.min(...next) } satisfies OutboxLine;
};

export interface ContactSections {
    readonly waiting: S2sContact[];
    readonly known: S2sContact[];
    readonly blocked: S2sContact[];
}

/** Contact requests waiting on a person here, oldest first, then every other contact, by name; blocked ones last. */
export const contactSections = (contacts: readonly S2sContact[]): ContactSections => {
    const byName = (a: S2sContact, b: S2sContact): number => a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
    return {
        waiting: contacts.filter((contact) => contact.state === `pending-in`).toSorted((a, b) => a.createdAt - b.createdAt),
        known: contacts.filter((contact) => contact.state !== `pending-in` && contact.state !== `blocked`).toSorted(byName),
        blocked: contacts.filter((contact) => contact.state === `blocked`).toSorted(byName),
    };
};

/** Contacts a message can go to now: accepted, and allowed to send messages back is theirs to say, not ours. */
export const messageable = (contacts: readonly S2sContact[]): S2sContact[] => contacts.filter((contact) => contact.state === `accepted`);

/** The notices a person has not read, newest first: what a contact's row raises. */
export const unseenNotices = (contact: S2sContact): S2sContactNotice[] => contact.notices.filter((notice) => !notice.seen).toSorted((a, b) => b.at - a.at);

/** A notice is a warning when it asks the reader to look: a new key vouched for only by DNS, or a removal. */
export const noticeTone = (notice: S2sContactNotice): `info` | `warning` => (notice.kind === `rekeyed-by-domain` || notice.kind === `removed` ? `warning` : `info`);

/**
 * A fingerprint as a person compares it aloud: its prefix, then the 52 characters in groups of four, thirteen groups.
 * Any other string comes back whole as one group, so a fingerprint this build does not know is never cut wrongly.
 */
export interface FingerprintGroups {
    readonly prefix: string;
    readonly groups: readonly string[];
}
export const fingerprintGroups = (fingerprint: string): FingerprintGroups => {
    const colon = fingerprint.indexOf(`:`);
    if (colon < 0) {
        return { prefix: ``, groups: [fingerprint] };
    }
    const body = fingerprint.slice(colon + 1);
    return { prefix: fingerprint.slice(0, colon + 1), groups: body.match(/.{1,4}/gu) ?? [] };
};

/** The short form a row names a key by: the prefix and the first two groups, enough to tell two apart at a glance. */
export const shortFingerprint = (fingerprint: string): string => {
    const { prefix, groups } = fingerprintGroups(fingerprint);
    return groups.length <= 2 ? fingerprint : `${prefix}${groups.slice(0, 2).join(` `)}…`;
};

/** Grants with a change laid over them, as the daemon applies one: each field given replaced, `task: null` taking it away. */
export const withGrants = (grants: S2sGrants, change: S2sGrantsUpdate): S2sGrants => {
    const next: S2sGrants = {
        message: change.message ?? grants.message,
        report: change.report ?? grants.report,
        records: change.records ?? grants.records,
        operate: change.operate ?? grants.operate,
        wake: change.wake ?? grants.wake,
    };
    const task = change.task === undefined ? grants.task : change.task;
    if (task !== null && task !== undefined) {
        next.task = task;
    }
    return next;
};
