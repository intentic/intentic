import { type Issue, type IssueReport, IssueSchema, type IssueStatus, type IssueSummary } from "@intentic/sandbox-contract";
import { jsonDir } from "../store/json-dir.js";
import { culpritOf, titleOf } from "./fingerprint.js";

/* THE INBOX. One file per fingerprint under `.intentic/records/issues/`, holding the group rather than the
 * events: what broke, where, how often, when it started, and the most recent one in full.
 *
 * DAEMON-OWNED, WHICH IS THE OPPOSITE OF DRAFTS, and the contrast is worth stating because the two look alike
 * from the outside (a directory of JSON the app renders as a queue). A draft is written by the AGENT and lives
 * under `config/`, so its store is careful about a second writer and its list confesses agent typos. Nothing
 * but this daemon writes an issue, so a file in here that will not parse is a bug in this daemon or a
 * half-written volume, which is why `invalid` still exists: to make that visible rather than to tolerate it.
 *
 * PER FILE RATHER THAN A MANIFEST, for json-dir's own reason turned up a notch: reports arrive concurrently
 * from every browser on a broken page, and a manifest would race a read-modify-write per crash. A group's file
 * is touched only by its own fingerprint's traffic, and the queue below orders even that.
 *
 * NOT the event store. An event tracker keeps every occurrence; this keeps the LATEST one and a count, because
 * what the agent needs is a bug to reproduce and how much it matters, and a per-event archive on a workspace
 * volume is a disk-filling machine with a public endpoint in front of it. */

/* How many groups this workspace keeps. A ceiling is not optional on a public endpoint: an attacker (or a
 * badly-behaved app putting a request id in every error message) mints a fresh fingerprint per report, and
 * without this the directory grows until the volume does not. */
const MAX_ISSUES = 500;

/* How far over the ceiling the directory may drift before a sweep runs. Amortization, and it is what keeps the
 * high-cardinality case from being O(n) reads PER REQUEST: without slack, every fresh insert past the ceiling
 * would re-read all 500 files to pick one victim, which turns the flood this bounds into the cost it was
 * supposed to avoid. */
const EVICT_SLACK = 50;

export interface RecordInput {
    readonly id: string;
    readonly automationId: string;
    readonly report: IssueReport;
    readonly origin?: string;
    readonly now: number;
    // The automation's escalation setting, passed in rather than read here so the store stays a store: what a
    // recurrence is worth is policy, and policy belongs at the route that also decides whether to wake anyone.
    readonly escalateAfter: number;
}

export interface RecordOutcome {
    readonly issue: IssueSummary;
    // First time this exact thing has been seen. The one case that always deserves a look.
    readonly fresh: boolean;
    // Known, but it has happened `escalateAfter` more times since the last time it woke anybody. The signal
    // that a tail has become a spike.
    readonly escalated: boolean;
}

export interface IssuesStore {
    // Most recently seen first: an inbox is read newest-down, and `lastSeen` is what "newest" means for a group
    // that started last week and is still happening.
    readonly list: () => Promise<{ issues: IssueSummary[]; invalid: string[] }>;
    readonly read: (id: string) => Promise<IssueSummary | undefined>;
    // Count one arrival: create the group or fold this report into it. The whole dedup, in one call, so no
    // caller can accidentally do half of it.
    readonly record: (input: RecordInput) => Promise<RecordOutcome>;
    // Triage. Returns undefined when there is no such issue, so a route can answer 404 rather than inventing one.
    readonly setStatus: (id: string, status: IssueStatus, now: number) => Promise<IssueSummary | undefined>;
    /* Mark that a turn was started for this group: link the conversation, move it to `investigating`, and
     * stamp `firedAt` at the count it stood at. That stamp IS the escalation rule's memory, so this must be
     * called whenever a wake is decided on, including one that goes to the approvals queue rather than
     * running: a hold that did not stamp would queue a fresh approval card per crash. */
    readonly noteRun: (id: string, conversationId: string, now: number) => Promise<void>;
    readonly remove: (id: string) => Promise<boolean>;
}

const MAX_RUNS = 20;

// A fingerprint nobody has seen before. Everything derived (title, culprit) is derived HERE and only here, so
// two arrivals of one crash can never end up filed under two names.
const freshIssue = ({ automationId, report, origin, now }: RecordInput): Issue => {
    const culprit = culpritOf(report.stack);
    return {
        kind: report.kind,
        title: titleOf(report),
        ...(culprit !== undefined ? { culprit } : {}),
        automationId,
        ...(origin !== undefined ? { origin } : {}),
        firstSeen: now,
        lastSeen: now,
        count: 1,
        status: "open",
        statusAt: now,
        ...(report.release !== undefined ? { release: report.release } : {}),
        sample: report,
    };
};

/* One more arrival of something already known.
 *
 * A RESOLVED ISSUE THAT HAPPENS AGAIN IS OPEN AGAIN, and it re-enters the escalation rule with a clean slate
 * (`firedAt` dropped), so the next arrival wakes somebody instead of waiting for the old count to grow by
 * another ten. "We fixed it and it came back" is the most important thing this inbox can say, and it is worth
 * an interruption. `ignored` is left exactly as it is: that one is the owner saying they know and do not care.
 *
 * The sample is replaced with the LATEST, not kept as the first: when a crash is still happening, what it
 * looks like now is what a fix has to reproduce, and the first one is often from a build that no longer exists.
 */
const folded = (existing: Issue, report: IssueReport, now: number): Issue => {
    const returned = existing.status === "resolved";
    const { firedAt, ...rest } = existing;
    return {
        ...rest,
        lastSeen: now,
        count: existing.count + 1,
        ...(returned ? { status: "open" as const, statusAt: now } : {}),
        ...(report.release !== undefined ? { release: report.release } : {}),
        sample: report,
        ...(returned || firedAt === undefined ? {} : { firedAt }),
    };
};

export const fileIssuesStore = (dir: string): IssuesStore => {
    const files = jsonDir<Issue>(dir, (raw) => IssueSchema.safeParse(raw).data);

    /* ONE CHAIN PER FINGERPRINT. `record` is a read-modify-write, and the traffic it is built for is a hundred
     * browsers hitting one bug in the same second: unserialized, they read the same count and write the same
     * count+1, and a crash affecting a thousand people reports as affecting three. Keyed by id, so two
     * different bugs never wait on each other, and the entry is dropped when its chain drains so the map does
     * not become the unbounded thing the file ceiling exists to prevent. */
    const chains = new Map<string, Promise<unknown>>();
    const serialize = <T>(id: string, job: () => Promise<T>): Promise<T> => {
        const tail = (chains.get(id) ?? Promise.resolve()).then(job, job);
        chains.set(id, tail);
        void tail.then(
            () => chains.get(id) === tail && chains.delete(id),
            () => chains.get(id) === tail && chains.delete(id),
        );
        return tail;
    };

    /* Known-good count of files, so the ceiling costs a directory read once rather than per insert. Starts
     * undefined and is learned by the first sweep; a daemon restart re-learns it. */
    let known: number | undefined;

    /* Make room, worst candidates first: what the owner has already dealt with, then what has not been seen for
     * longest. `investigating` is never evicted, something is actively working on it and deleting the brief
     * out from under a running turn is the one outcome nobody could explain afterwards. */
    const sweep = async (): Promise<void> => {
        const { entries } = await files.list();
        known = entries.length;
        if (entries.length <= MAX_ISSUES) {
            return;
        }
        const rank = (issue: IssueSummary): number => (issue.status === "resolved" || issue.status === "ignored" ? 0 : 1);
        const victims = entries
            .filter((issue) => issue.status !== "investigating")
            .toSorted((a, b) => rank(a) - rank(b) || a.lastSeen - b.lastSeen)
            .slice(0, entries.length - MAX_ISSUES);
        for (const victim of victims) {
            await files.remove(victim.id);
        }
        known = entries.length - victims.length;
    };

    /* One more group exists. The ceiling is kept amortized here: the directory size is learned on the first
     * insert of a boot and swept only once the drift past the ceiling has built up, so the flood this bounds
     * does not pay a directory read per report. */
    const countedOne = async (): Promise<void> => {
        known = known === undefined ? undefined : known + 1;
        if (known === undefined || known > MAX_ISSUES + EVICT_SLACK) {
            await sweep();
        }
    };

    const write = async (id: string, issue: Issue): Promise<IssueSummary> => {
        await files.write(id, issue);
        return { ...issue, id };
    };

    return {
        list: async () => {
            const { entries, invalid } = await files.list();
            known = entries.length;
            return { issues: entries.toSorted((a, b) => b.lastSeen - a.lastSeen), invalid };
        },

        read: (id) => files.read(id),

        record: (input) =>
            serialize(input.id, async () => {
                const existing = await files.read(input.id);
                if (existing === undefined) {
                    const issue = await write(input.id, freshIssue(input));
                    await countedOne();
                    return { issue, fresh: true, escalated: false };
                }
                const { id: _id, ...body } = existing;
                const next = folded(body, input.report, input.now);
                /* A RESOLVED ISSUE THAT COMES BACK ESCALATES ON THE SPOT, without waiting to grow by another
                 * step. The step is a rule about how much MORE of a known problem is worth an interruption,
                 * and a bug that was declared fixed is not a known problem, it is a fix that did not hold.
                 * Making it wait would mean hearing about a failed fix only after it had failed ten more times.
                 */
                const returned = body.status === "resolved";
                return {
                    issue: await write(input.id, next),
                    fresh: false,
                    escalated: returned || next.count - (next.firedAt ?? 0) >= input.escalateAfter,
                };
            }),

        setStatus: (id, status, now) =>
            serialize(id, async () => {
                const existing = await files.read(id);
                if (existing === undefined) {
                    return undefined;
                }
                const { id: _id, ...body } = existing;
                return write(id, { ...body, status, statusAt: now });
            }),

        noteRun: (id, conversationId, now) =>
            serialize(id, async () => {
                const existing = await files.read(id);
                if (existing === undefined) {
                    return;
                }
                const { id: _id, ...body } = existing;
                await write(id, {
                    ...body,
                    status: "investigating",
                    statusAt: now,
                    // What the count stood at when this run started: the escalation rule's memory, and what
                    // makes a later recurrence read as "it came back" rather than "somebody already looked".
                    firedAt: existing.count,
                    runs: [...(existing.runs ?? []), { conversationId, at: now, atCount: existing.count }].slice(-MAX_RUNS),
                });
            }),

        remove: async (id) => {
            const removed = await files.remove(id);
            if (removed && known !== undefined) {
                known -= 1;
            }
            return removed;
        },
    };
};
