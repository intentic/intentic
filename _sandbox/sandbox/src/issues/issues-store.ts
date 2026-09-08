import { type Issue, type IssueReport, IssueSchema, type IssueStatus, type IssueSummary } from "@intentic/sandbox-contract";
import { jsonDir } from "../store/json-dir.js";
import { culpritOf, titleOf } from "./fingerprint.js";

// One file per fingerprint under `.intentic/records/issues/`, holding the group (what broke, how often, when, the
// latest sample), not every event. Daemon-owned, unlike an agent-written draft: nothing but this daemon writes an
// issue, so an unparseable file is a daemon bug. Per-file rather than a manifest, since concurrent reports would race a
// manifest's read-modify-write; a group's own fingerprint serializes only its own traffic.

// Group ceiling: not optional on a public endpoint, where a fresh fingerprint per report can grow it forever.
const MAX_ISSUES = 500;

// Drift allowed past the ceiling before a sweep runs; without it, every insert past it re-scans every file.
const EVICT_SLACK = 50;

export interface RecordInput {
    readonly id: string;
    readonly automationId: string;
    readonly report: IssueReport;
    readonly origin?: string;
    readonly now: number;
    // Passed in, not read here, so the store stays a store: what a recurrence is worth is the route's policy.
    readonly escalateAfter: number;
}

export interface RecordOutcome {
    readonly issue: IssueSummary;
    // First time this exact thing has been seen. The one case that always deserves a look.
    readonly fresh: boolean;
    // Known, but happened escalateAfter more times since it last woke anyone; a tail becoming a spike.
    readonly escalated: boolean;
}

export interface IssuesStore {
    // Most recently seen first: for a group still happening, lastSeen is what "newest" means, not when it started.
    readonly list: () => Promise<{ issues: IssueSummary[]; invalid: string[] }>;
    readonly read: (id: string) => Promise<IssueSummary | undefined>;
    // Counts one arrival, creating or folding the group; the whole dedup in one call, so nobody does half of it.
    readonly record: (input: RecordInput) => Promise<RecordOutcome>;
    // Triage. Returns undefined when there is no such issue, so a route can answer 404 rather than inventing one.
    readonly setStatus: (id: string, status: IssueStatus, now: number) => Promise<IssueSummary | undefined>;
    // Links the run, moves to investigating, stamps firedAt (escalation's memory); call even for a held wake.
    readonly noteRun: (id: string, conversationId: string, now: number) => Promise<void>;
    readonly remove: (id: string) => Promise<boolean>;
}

const MAX_RUNS = 20;

// A fingerprint nobody has seen before; title and culprit are derived only here, so two arrivals of one crash never end
// up under two names.
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

// A resolved issue that recurs reopens with a clean escalation slate (firedAt dropped), waking at once instead of
// waiting to grow again; ignored is left untouched. The sample is replaced with the latest, since that's what a fix has
// to reproduce now.
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

    // One chain per fingerprint, dropped once drained, so concurrent arrivals of one bug are never undercounted.
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

    // Cached file count so the ceiling costs one directory read, not one per insert; relearned after a restart.
    let known: number | undefined;

    // Makes room, worst candidates first: resolved/ignored before oldest-seen. `investigating` is never evicted,
    // deleting a brief out from under a running turn is unexplainable.
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

    // One more group exists; amortized so the flood this bounds doesn't pay a directory read per report.
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
                // A resolved issue recurring escalates at once, rather than waiting ten more counts for a fix that
                // didn't hold.
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
                    // Count when this run started: escalation's memory, telling "it came back" apart from "already
                    // looked at".
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
