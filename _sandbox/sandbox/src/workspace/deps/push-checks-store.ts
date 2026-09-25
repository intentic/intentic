import { type MainlinePush, MainlinePushSchema, PushFindingKindSchema, PushFindingSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { jsonFile } from "../../store/json-file.js";
import { objectParse } from "../../store/unknown-keys.js";
import { stateRelPath } from "../../state-paths.js";

// What each push check found and let through (<workspace>/.intentic/records/push-checks.json), and what became of every
// finding since. The pre-push hook never refuses a push: it measures, prints, and leaves a report in the repository's
// git common dir (push-checks.ts reads it). Filed here, a finding stays open until a later measurement no longer prints
// it or somebody dismisses it. Nothing is sent after one; acting on it is the owner's press (agents/fix/push-fix.ts).

// A finding as filed: the wire's, plus the key the hook gave it, which a later measurement names it by. Never sent.
const StoredFindingSchema = PushFindingSchema.extend({ key: z.string() });
const StoredPushSchema = MainlinePushSchema.extend({ findings: z.array(StoredFindingSchema) });
const PushChecksStateSchema = z.object({
    // Newest first.
    pushes: z.array(StoredPushSchema).default([]),
    // Report ids already filed or set aside, so a report read again is not filed twice; newest first, bounded.
    seen: z.array(z.string()).default([]),
});

export type StoredFinding = z.infer<typeof StoredFindingSchema>;
export type StoredPush = z.infer<typeof StoredPushSchema>;
export type PushChecksState = z.infer<typeof PushChecksStateSchema>;

export const pushChecksDocument = defineDocument({ path: stateRelPath(".intentic/records/push-checks.json"), schema: PushChecksStateSchema });

// Pushes kept across every project; one that still has an open finding outlives this, up to the hard cap.
export const PUSHES_KEPT = 30;
export const PUSHES_CAP = 60;
// A report file holds at most ten entries, so this covers twenty repositories pushing at once before an id still in a
// file could be forgotten and filed again (and a push already filed is never filed twice anyway).
export const SEEN_KEPT = 200;

// THE REPORT the hook writes, as the daemon reads it. Parsed leniently: an entry, a push or a finding that does not
// parse is skipped rather than failing the whole file, and a version this build does not know is ignored.

// Keeps the items of an array that parse, drops the rest.
const lenientArray = <T extends z.ZodType>(item: T) =>
    z.array(z.unknown()).transform((items) =>
        items.flatMap((raw) => {
            const parsed = item.safeParse(raw);
            return parsed.success ? [parsed.data as z.infer<T>] : [];
        }),
    );

const ReportFindingSchema = z.object({
    kind: PushFindingKindSchema,
    check: z.string().optional(),
    gate: z.enum(["code", "tidy"]).optional(),
    text: z.string(),
    key: z.string(),
    command: z.string().optional(),
    commit: z.object({ sha: z.string(), subject: z.string() }).optional(),
});
const ReportPushSchema = z.object({ ref: z.string(), head: z.string().min(1), base: z.string().optional(), commits: z.number() });
const CheckMeasureSchema = z.object({ ok: z.boolean(), measured: z.boolean(), keys: z.array(z.string()) });
const MeasuredSchema = z.object({
    checks: z.record(z.string(), CheckMeasureSchema),
    lint: z.enum(["passed", "failed"]).optional(),
});
export const PushReportEntrySchema = z.object({
    version: z.literal(1),
    id: z.string().min(1),
    at: z.number(),
    kind: z.enum(["push", "recheck"]),
    remote: z.string().optional(),
    pushes: lenientArray(ReportPushSchema).optional(),
    findings: lenientArray(ReportFindingSchema).optional(),
    measured: MeasuredSchema.optional().catch(undefined),
    recheck: z.array(z.string()).catch([]),
});
export type PushReportEntry = z.infer<typeof PushReportEntrySchema>;
export type PushMeasured = z.infer<typeof MeasuredSchema>;

// Every entry of a report file that this build can read, oldest first; anything else in the file is nothing.
export const parsePushReport = (text: string): PushReportEntry[] => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        // silent-catch: a file the hook is still writing, or one somebody broke, files nothing; the next ref move reads it again
        return [];
    }
    return (Array.isArray(raw) ? lenientArray(PushReportEntrySchema).parse(raw) : []).toSorted((left, right) => left.at - right.at);
};

// FNV-1a, as the conversation ids spell it: the same problem found again must be the same id on every read.
const digest = (text: string): string => {
    let hash = 0x811c_9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 0x0100_0193);
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
};

// Stable across pushes: what measured it, which check, and the key the hook named it by (its text when it named none).
export const pushFindingId = (finding: {
    readonly kind: string;
    readonly check?: string | undefined;
    readonly key: string;
    readonly text: string;
}): string => `${finding.kind}:${finding.check ?? ""}:${digest(finding.key !== "" ? finding.key : finding.text)}`;

const isOpen = (finding: StoredFinding): boolean => finding.state === "open";

export const openCount = (pushes: readonly StoredPush[], project: string): number =>
    pushes.filter((push) => push.project === project).reduce((sum, push) => sum + push.findings.filter(isOpen).length, 0);

// What a measurement says of one open finding: gone, still there, or nothing (it did not measure what found it). Only
// a check's and the linter's findings can be measured again; the ratchet, the lockstep and rustfmt are about the pushed
// commits themselves.
const verdictOf = (finding: StoredFinding, measured: PushMeasured): "gone" | "standing" | undefined => {
    if (finding.kind === "check") {
        const measure = finding.check === undefined ? undefined : measured.checks[finding.check];
        if (measure === undefined || !measure.measured) {
            return undefined;
        }
        return measure.ok || (finding.key !== "" && !measure.keys.includes(finding.key)) ? "gone" : "standing";
    }
    if (finding.kind === "lint") {
        return measured.lint === undefined ? undefined : measured.lint === "passed" ? "gone" : "standing";
    }
    return undefined;
};

export interface Tally {
    // Findings this measurement found gone.
    readonly resolved: number;
    // Findings still open in the project afterwards.
    readonly open: number;
}

// Resolves every open finding in `project` the measurement no longer prints, on pushes it could speak about: those
// checked at or before it, and not the one it came with (`except`). A push any of whose findings it judged is stamped.
export const applyMeasured = (
    state: PushChecksState,
    project: string,
    measured: PushMeasured | undefined,
    at: number,
    except?: string,
): { readonly state: PushChecksState; readonly resolved: number } => {
    if (measured === undefined) {
        return { state, resolved: 0 };
    }
    let resolved = 0;
    const pushes = state.pushes.map((push) => {
        if (push.project !== project || push.id === except || push.at > at || !push.findings.some(isOpen)) {
            return push;
        }
        let judged = false;
        const findings = push.findings.map((finding) => {
            const verdict = isOpen(finding) ? verdictOf(finding, measured) : undefined;
            judged ||= verdict !== undefined;
            if (verdict !== "gone") {
                return finding;
            }
            resolved += 1;
            return { ...finding, state: "resolved" as const, settledAt: at };
        });
        return judged ? { ...push, findings, measuredAt: at } : push;
    });
    return { state: resolved === 0 && pushes.every((push, index) => push === state.pushes[index]) ? state : { ...state, pushes }, resolved };
};

// The newest pushes, plus any older one still holding an open finding, up to the cap.
export const retained = (pushes: readonly StoredPush[]): StoredPush[] =>
    pushes.filter((push, index) => index < PUSHES_KEPT || push.findings.some(isOpen)).slice(0, PUSHES_CAP);

const seenWith = (seen: readonly string[], id: string): string[] => [id, ...seen.filter((each) => each !== id)].slice(0, SEEN_KEPT);

// Files a push report that reached the remote: its findings open, less any still open from an earlier push of the
// project (the same problem, still standing), then what it measured applied to the older pushes.
export const ingestPush = (
    state: PushChecksState,
    project: string,
    report: PushReportEntry,
): { readonly state: PushChecksState; readonly resolved: number } => {
    const first = report.pushes?.[0];
    if (first === undefined || state.pushes.some((push) => push.project === project && push.id === report.id)) {
        const { state: measured, resolved } = applyMeasured(state, project, report.measured, report.at);
        return { state: { ...measured, seen: seenWith(measured.seen, report.id) }, resolved };
    }
    const standing = new Set(
        state.pushes.filter((push) => push.project === project).flatMap((push) => push.findings.filter(isOpen).map((finding) => finding.id)),
    );
    const findings: StoredFinding[] = [];
    for (const found of report.findings ?? []) {
        const id = pushFindingId(found);
        if (standing.has(id)) {
            continue;
        }
        standing.add(id);
        findings.push({
            id,
            kind: found.kind,
            ...(found.check === undefined ? {} : { check: found.check }),
            ...(found.gate === undefined ? {} : { gate: found.gate }),
            text: found.text,
            ...(found.command === undefined ? {} : { command: found.command }),
            ...(found.commit === undefined ? {} : { commit: found.commit }),
            state: "open",
            key: found.key,
        });
    }
    const push: StoredPush = {
        project,
        id: report.id,
        at: report.at,
        ...(report.remote === undefined ? {} : { remote: report.remote }),
        ...(first.ref.startsWith("refs/heads/") ? { branch: first.ref.slice("refs/heads/".length) } : {}),
        ...(first.base === undefined ? {} : { base: first.base }),
        head: first.head,
        commits: (report.pushes ?? []).reduce((sum, each) => sum + each.commits, 0),
        findings,
    };
    // By when each was checked, so a push filed late (its remote-tracking ref moved after a later one's) sits in its place.
    const filed = { ...state, pushes: [push, ...state.pushes].toSorted((left, right) => right.at - left.at) };
    const { state: measured, resolved } = applyMeasured(filed, project, report.measured, report.at, report.id);
    return { state: { pushes: retained(measured.pushes), seen: seenWith(measured.seen, report.id) }, resolved };
};

// A measurement that files no push (a recheck, or a push the remote refused): what it measured still stands.
export const ingestMeasurement = (
    state: PushChecksState,
    project: string,
    report: PushReportEntry,
): { readonly state: PushChecksState; readonly resolved: number } => {
    const { state: measured, resolved } = applyMeasured(state, project, report.measured, report.at);
    return { state: { ...measured, seen: seenWith(measured.seen, report.id) }, resolved };
};

// Sets open findings aside, the named ones in every push of the project that holds them open (every open one when none
// is named), or opens named dismissed ones again. An undo means the copy dismissed last, so that is the one reopened, and
// none is where the same problem is already open again in a later push: the open copy stands for it.
export const dismissIn = (
    state: PushChecksState,
    project: string,
    ids: readonly string[] | undefined,
    restore: boolean,
    now: number,
): { readonly state: PushChecksState; readonly changed: number } => {
    const mine = state.pushes.filter((push) => push.project === project);
    const open = new Set(mine.flatMap((push) => push.findings.filter(isOpen).map((finding) => finding.id)));
    // Which push's copy of each named id is reopened: the one dismissed last.
    const reopen = new Map<string, { readonly push: string; readonly at: number }>();
    for (const push of restore && ids !== undefined ? mine : []) {
        for (const finding of push.findings) {
            const best = reopen.get(finding.id);
            if (
                finding.state === "dismissed" &&
                ids?.includes(finding.id) === true &&
                !open.has(finding.id) &&
                (best === undefined || (finding.settledAt ?? 0) > best.at)
            ) {
                reopen.set(finding.id, { push: push.id, at: finding.settledAt ?? 0 });
            }
        }
    }
    const settle = (push: StoredPush, finding: StoredFinding): StoredFinding => {
        if (!restore && isOpen(finding) && (ids === undefined || ids.includes(finding.id))) {
            return { ...finding, state: "dismissed", settledAt: now };
        }
        if (restore && finding.state === "dismissed" && reopen.get(finding.id)?.push === push.id) {
            const { settledAt: _settled, ...rest } = finding;
            return { ...rest, state: "open" };
        }
        return finding;
    };
    let changed = 0;
    const pushes = state.pushes.map((push) => {
        if (push.project !== project) {
            return push;
        }
        const findings = push.findings.map((finding) => settle(push, finding));
        const moved = findings.filter((finding, index) => finding !== push.findings[index]).length;
        changed += moved;
        return moved === 0 ? push : { ...push, findings };
    });
    return { state: changed === 0 ? state : { ...state, pushes }, changed };
};

// Every push as the wire carries it: the keys the store names findings by stay here.
export const publicPushes = (pushes: readonly StoredPush[]): MainlinePush[] =>
    pushes.map((push) => ({ ...push, findings: push.findings.map(({ key: _key, ...finding }) => finding) }));

export interface PushChecksStore {
    readonly read: () => Promise<PushChecksState>;
    // Files a push report that reached the remote, and marks it seen.
    readonly ingest: (project: string, report: PushReportEntry) => Promise<Tally>;
    // Applies a measurement that files no push (a recheck, a refused push), and marks it seen.
    readonly measure: (project: string, report: PushReportEntry) => Promise<Tally>;
    readonly dismiss: (project: string, ids: readonly string[] | undefined, restore: boolean, now?: number) => Promise<number>;
}

export const filePushChecksStore = (path: string): PushChecksStore => {
    const file = jsonFile<PushChecksState>(path, {
        parse: objectParse(PushChecksStateSchema),
        fallback: () => ({ pushes: [], seen: [] }),
        document: pushChecksDocument,
    });
    const tallied =
        (
            step: (
                state: PushChecksState,
                project: string,
                report: PushReportEntry,
            ) => { readonly state: PushChecksState; readonly resolved: number },
        ) =>
        async (project: string, report: PushReportEntry): Promise<Tally> => {
            let resolved = 0;
            const written = await file.update((current) => {
                const next = step(current, project, report);
                resolved = next.resolved;
                return next.state;
            });
            return { resolved, open: openCount(written.pushes, project) };
        };
    return {
        read: () => file.read(),
        ingest: tallied(ingestPush),
        measure: tallied(ingestMeasurement),
        dismiss: async (project, ids, restore, now = Date.now()) => {
            let changed = 0;
            await file.update((current) => {
                const next = dismissIn(current, project, ids, restore, now);
                changed = next.changed;
                return next.state;
            });
            return changed;
        },
    };
};
