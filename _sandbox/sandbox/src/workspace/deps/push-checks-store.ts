import {
    fnvDigest,
    legacyKindOf,
    type MainlinePush,
    MainlinePushSchema,
    PushFindingKindSchema,
    PushFindingSchema,
    pushFindingRecheckable,
    pushFindingSource,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { stateRelPath } from "../../state-paths.js";
import { opt } from "../../opt.js";

// What each push check found and let through (<workspace>/.intentic/records/push-checks.json), and what became of every
// finding since. The pre-push hook never refuses a push: it measures, prints, and leaves a report in the repository's
// git common dir (push-checks.ts reads it). Filed here, a finding stays open until a later measurement no longer prints
// it or somebody dismisses it. Nothing is sent after one; acting on it is the owner's press (conversations/fix/push-fix.ts).

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

// A finding names what measured it by a free `source` (any repository's tooling, with `recheckable` saying whether a
// later measurement can find it gone), or, from a hook written before that, by the `kind` enum (and `check`).
const ReportFindingSchema = z
    .object({
        source: z.string().min(1).optional(),
        kind: PushFindingKindSchema.optional(),
        check: z.string().optional(),
        recheckable: z.boolean().optional(),
        gate: z.enum(["code", "tidy"]).optional(),
        text: z.string(),
        key: z.string(),
        path: z.string().optional(),
        command: z.string().optional(),
        commit: z.object({ sha: z.string(), subject: z.string() }).optional(),
    })
    .refine((finding) => finding.source !== undefined || finding.kind !== undefined);
type ReportFinding = z.infer<typeof ReportFindingSchema>;

// A reported finding as one shape whichever way it named its source: the kind and check older editors read, derived from
// the source when the report named only that.
const normalized = (found: ReportFinding) => {
    const named = found.kind === undefined ? legacyKindOf(found.source!) : { kind: found.kind, ...(found.check === undefined ? {} : { check: found.check }) };
    const source = found.source ?? pushFindingSource(named);
    return { ...named, source, recheckable: found.recheckable ?? pushFindingRecheckable(named) };
};
const ReportPushSchema = z.object({ ref: z.string(), head: z.string().min(1), base: z.string().optional(), commits: z.number() });
// What one source said at a measurement: whether it passed, whether it could run at all, and the keys of what it printed.
const CheckMeasureSchema = z.object({ ok: z.boolean(), measured: z.boolean(), keys: z.array(z.string()) });
const MeasuredSchema = z.object({
    // By source: every check, and any other source the repository's tooling measured.
    checks: z.record(z.string(), CheckMeasureSchema),
    // The linter as the first reports measured it, beside the checks rather than among them.
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
        // allow(silent-catch): a file the hook is still writing, or one somebody broke, files nothing; the next ref move reads it again
        return [];
    }
    return (Array.isArray(raw) ? lenientArray(PushReportEntrySchema).parse(raw) : []).toSorted((left, right) => left.at - right.at);
};

// Stable across pushes: what measured it, which check, and the key the hook named it by (its text when it named none).
// The kind and check are the ones older reports named, so a finding keeps its id whichever way its report named it.
export const pushFindingId = (finding: {
    readonly kind: string;
    readonly check?: string | undefined;
    readonly key: string;
    readonly text: string;
}): string => `${finding.kind}:${finding.check ?? ""}:${fnvDigest(finding.key !== "" ? finding.key : finding.text)}`;

const isOpen = (finding: StoredFinding): boolean => finding.state === "open";

export const openCount = (pushes: readonly StoredPush[], project: string): number =>
    pushes.filter((push) => push.project === project).reduce((sum, push) => sum + push.findings.filter(isOpen).length, 0);

// What the measurement says of one source: its own entry, or the linter as the first reports measured it.
const measureOf = (measured: PushMeasured, source: string): z.infer<typeof CheckMeasureSchema> | undefined =>
    measured.checks[source] ?? (source === "lint" && measured.lint !== undefined ? { ok: measured.lint === "passed", measured: true, keys: [] } : undefined);

// What a measurement says of one open finding: gone, still there, or nothing (it did not measure what found it). Only a
// recheckable finding can be measured again; one about commits already pushed ends only when dismissed.
const verdictOf = (finding: StoredFinding, measured: PushMeasured): "gone" | "standing" | undefined => {
    if (!pushFindingRecheckable(finding)) {
        return undefined;
    }
    const measure = measureOf(measured, pushFindingSource(finding));
    if (measure === undefined || !measure.measured) {
        return undefined;
    }
    return measure.ok || (finding.key !== "" && !measure.keys.includes(finding.key)) ? "gone" : "standing";
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

// A reported finding as filed: open, under the id its kind, check and key give it.
const storedFindingOf = (found: ReportFinding): StoredFinding => {
    const { kind, check, source, recheckable } = normalized(found);
    return {
        id: pushFindingId({ kind, check, key: found.key, text: found.text }),
        kind,
        ...opt("check", check),
        source,
        recheckable,
        ...opt("gate", found.gate),
        text: found.text,
        ...opt("path", found.path),
        ...opt("command", found.command),
        ...opt("commit", found.commit),
        state: "open",
        key: found.key,
    };
};

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
        const finding = storedFindingOf(found);
        if (standing.has(finding.id)) {
            continue;
        }
        standing.add(finding.id);
        findings.push(finding);
    }
    const push: StoredPush = {
        project,
        id: report.id,
        at: report.at,
        ...opt("remote", report.remote),
        ...opt("branch", first.ref.startsWith("refs/heads/") ? first.ref.slice("refs/heads/".length) : undefined),
        ...opt("base", first.base),
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

// A PUSH THE REPOSITORY'S OWN HOOK REFUSED. Nothing reached the remote, so no report of this sandbox's tooling was filed
// for it (a hook of any repository may refuse); the daemon files it here itself, as a push whose one finding is what the
// hook printed, so the owner's hand-over (conversations/fix/push-fix.ts) reads it from the same place as every other finding.
export const REFUSAL_SOURCE = "pre-push";
// What of the hook's output a refusal keeps: its end, where a hook says what failed.
const REFUSAL_TAIL = 4_000;

export interface PushRefusal {
    readonly at: number;
    // The commit that was being pushed.
    readonly head: string;
    readonly branch?: string | undefined;
    readonly remote?: string | undefined;
    readonly output: string;
}

// The open findings of every refused push in the project, settled: a later push answered for the same work, passing or
// refused again. Returns the state unchanged (by reference) when there was none.
export const settleRefusals = (state: PushChecksState, project: string, at: number): PushChecksState => {
    let moved = false;
    const pushes = state.pushes.map((push) => {
        if (push.project !== project || push.refused !== true || !push.findings.some(isOpen)) {
            return push;
        }
        moved = true;
        return { ...push, findings: push.findings.map((finding) => (isOpen(finding) ? { ...finding, state: "resolved" as const, settledAt: at } : finding)) };
    });
    return moved ? { ...state, pushes } : state;
};

// Files one refusal, settling any the project had before it.
export const fileRefusal = (state: PushChecksState, project: string, refusal: PushRefusal): PushChecksState => {
    const text = refusal.output.trim().slice(-REFUSAL_TAIL);
    const push: StoredPush = {
        project,
        id: `refused-${refusal.at.toString(36)}`,
        at: refusal.at,
        ...opt("remote", refusal.remote),
        ...opt("branch", refusal.branch),
        head: refusal.head,
        commits: 0,
        refused: true,
        findings: [
            {
                id: pushFindingId({ ...legacyKindOf(REFUSAL_SOURCE), key: "", text }),
                ...legacyKindOf(REFUSAL_SOURCE),
                source: REFUSAL_SOURCE,
                // Only the hook passing answers it, and that is a push: it settles then, never at a measurement.
                recheckable: false,
                text: text === "" ? "the pre-push hook refused the push without saying why" : text,
                command: "git push --dry-run",
                state: "open",
                key: "",
            },
        ],
    };
    const settled = settleRefusals(state, project, refusal.at);
    return { ...settled, pushes: retained([push, ...settled.pushes].toSorted((left, right) => right.at - left.at)) };
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
    // Files a push the repository's own hook refused.
    readonly refuse: (project: string, refusal: PushRefusal) => Promise<void>;
    // A push reached the remote: what earlier refusals said is answered.
    readonly pushed: (project: string, at: number) => Promise<void>;
}

export const filePushChecksStore = (path: string): PushChecksStore => {
    const file = openDocument<typeof pushChecksDocument, PushChecksState>(pushChecksDocument, path, {
        unknownKeys: true,
        fallback: () => ({ pushes: [], seen: [] }),
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
        refuse: async (project, refusal) => {
            await file.update((current) => fileRefusal(current, project, refusal));
        },
        pushed: async (project, at) => {
            await file.update((current) => settleRefusals(current, project, at));
        },
    };
};
