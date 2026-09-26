import {
    FindingSchema,
    fnvDigest,
    type MainlinePush,
    MainlinePushSchema,
    type MainlineRouting,
    nextStreak,
    type Red,
    RedSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { isJsonObject, type JsonObject, transform } from "../../store/evolution/conversions.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { stateRelPath } from "../../state-paths.js";
import { opt } from "../../opt.js";

// What each push check found and let through (<workspace>/.intentic/records/push-checks.json), and what of it is still
// owed. The pre-push hook never refuses a push: it measures, prints, and leaves a report in the repository's git common
// dir (push-checks.ts reads it). Filed here, each push keeps what it found, and each project's push Red (contract,
// RedSchema: source `push`, scope the project) holds what is still owed, by the one streak rule (contract, nextStreak),
// with every decision about it: what a measurement found gone, what the owner dismissed, who it was handed to. Nothing
// is sent after one; acting on it is the owner's press (RED_POLICY, conversations/fix/push-fix.ts).

// A finding as filed: the one Finding shape, plus the key the hook gave it, which a later measurement names it by. The key
// never leaves the daemon.
const StoredFindingSchema = FindingSchema.extend({ key: z.string() });
const StoredPushSchema = MainlinePushSchema.extend({ findings: z.array(StoredFindingSchema) });
// A project's push Red as filed: its source and scope are the file's and the key it is kept under.
const PushRedSchema = RedSchema.omit({ source: true, scope: true }).extend({ findings: z.array(StoredFindingSchema).default([]) });
const PushChecksStateSchema = z.object({
    // Newest first.
    pushes: z.array(StoredPushSchema).default([]),
    // By project; only projects owed something right now.
    reds: z.record(z.string(), PushRedSchema).default({}),
    // The red a project ended with, while no newer one stands: an undo of the dismissal that ended it brings it back
    // whole, with its start and its decisions, rather than starting a fresh red (and a fresh hand-over).
    ended: z.record(z.string(), PushRedSchema).default({}),
    // Report ids already filed or set aside, so a report read again is not filed twice; newest first, bounded.
    seen: z.array(z.string()).default([]),
});

export type StoredFinding = z.infer<typeof StoredFindingSchema>;
export type StoredPush = z.infer<typeof StoredPushSchema>;
export type PushRed = z.infer<typeof PushRedSchema>;
export type PushChecksState = z.infer<typeof PushChecksStateSchema>;

// Stable across pushes: what measured it, and the key the hook named it by (its text when it named none).
export const pushFindingId = (finding: { readonly source: string; readonly key: string; readonly text: string }): string =>
    `${finding.source}:${fnvDigest(finding.key !== "" ? finding.key : finding.text)}`;

// THE FILE BEFORE 2026-09-26, when every push kept its findings with a state of their own (`open`, `resolved`,
// `dismissed`), named what measured each by a `kind` enum (and `check`) as well as `source`, and ids spelled from the
// kind. Converted once: each finding keeps its words under an id from its source, and each project's open findings
// become its push Red, begun when the oldest push holding one was checked. What was resolved or dismissed is history
// already; the pushes keep it as what they found.
type LegacyFinding = JsonObject & {
    readonly text: string;
    readonly key: string;
    readonly kind?: string;
    readonly check?: string;
    readonly source?: string;
    readonly recheckable?: boolean;
};
type LegacyPush = JsonObject & {
    readonly project: string;
    readonly id: string;
    readonly at: number;
    readonly head: string;
    readonly commits: number;
    readonly findings: readonly LegacyFinding[];
};
type LegacyState = JsonObject & { readonly pushes?: readonly LegacyPush[] };
// Before `source` and `recheckable`, a check's and the linter's findings were the ones a measurement could clear.
const LEGACY_RECHECKABLE: ReadonlySet<string> = new Set(["check", "lint"]);
const isLegacyState = (value: JsonObject): value is LegacyState =>
    Array.isArray(value["pushes"]) &&
    value["pushes"].some((push) => isJsonObject(push) && Array.isArray(push["findings"]) && push["findings"].some((finding) => isJsonObject(finding) && "state" in finding));
const sourceOf = (finding: LegacyFinding): string => finding.source ?? (finding.kind === "check" ? (finding.check ?? "check") : (finding.kind ?? "check"));
const convertedFinding = (finding: LegacyFinding): StoredFinding => {
    const source = sourceOf(finding);
    const { kind: _kind, check: _check, state: _state, settledAt: _settled, id: _id, ...kept } = finding;
    return {
        ...(kept as Omit<StoredFinding, "id" | "source" | "recheckable">),
        id: pushFindingId({ source, key: finding.key, text: finding.text }),
        source,
        recheckable: finding.recheckable ?? LEGACY_RECHECKABLE.has(finding.kind ?? ""),
    };
};
const convertedState = (value: LegacyState): JsonObject & { readonly pushes: StoredPush[]; readonly reds: Record<string, PushRed> } => {
    const reds: Record<string, PushRed> = {};
    // Oldest first, so each project's red begins at the oldest push still holding an open finding.
    const legacy = value.pushes ?? [];
    for (const push of legacy.toReversed()) {
        for (const finding of push.findings.filter((each) => each["state"] === "open")) {
            const converted = convertedFinding(finding);
            const red = reds[push.project] ?? { since: push.at, findings: [], suspects: [], named: false, decisions: [] };
            reds[push.project] = red.findings.some((owed) => owed.id === converted.id) ? red : { ...red, findings: [...red.findings, converted] };
        }
    }
    const pushes = legacy.map((push) => {
        const { measuredAt: _measured, findings, ...kept } = push;
        return { ...kept, findings: findings.map(convertedFinding) };
    });
    return { ...value, pushes, reds };
};

export const pushChecksDocument = defineDocument({
    path: stateRelPath(".intentic/records/push-checks.json"),
    schema: PushChecksStateSchema,
    history: [transform("files what each project's pushes left open as its push Red", isLegacyState, convertedState)],
});

// Pushes kept across every project; one that still has an owed finding outlives this, up to the hard cap.
export const PUSHES_KEPT = 30;
export const PUSHES_CAP = 60;
// A report file holds at most ten entries, so this covers twenty repositories pushing at once before an id still in a
// file could be forgotten and filed again (and a push already filed is never filed twice anyway).
export const SEEN_KEPT = 200;

// THE REPORT the hook writes, as the daemon reads it. The file is another program's (any repository's tooling may write
// it, at any version), so it is parsed leniently: an entry, a push or a finding that does not parse is skipped rather
// than failing the whole file, and an entry of a version this build does not know is ignored.

// Keeps the items of an array that parse, drops the rest.
const lenientArray = <T extends z.ZodType>(item: T) =>
    z.array(z.unknown()).transform((items) =>
        items.flatMap((raw) => {
            const parsed = item.safeParse(raw);
            // SAFETY: `item` parsed it, so the data is what `item` infers; zod types a generic schema's output loosely.
            return parsed.success ? [parsed.data as z.infer<T>] : [];
        }),
    );

// A reported finding: the Finding the daemon files, less the id it gives it, plus the hook's key. What measured it is its
// `source`; a hook written before that named only a `kind` (and `check`), read here into a source and nowhere else.
const ReportFindingSchema = FindingSchema.omit({ id: true, source: true, recheckable: true })
    .extend({
        source: z.string().min(1).optional(),
        recheckable: z.boolean().optional(),
        key: z.string(),
        kind: z.string().optional(),
        check: z.string().optional(),
    })
    .refine((finding) => finding.source !== undefined || finding.kind !== undefined);
type ReportFinding = z.infer<typeof ReportFindingSchema>;

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

// A reported finding as filed: under the id its source and key give it.
const storedFindingOf = (found: ReportFinding): StoredFinding => {
    const { kind, check, source: named, recheckable: said, key, ...rest } = found;
    const source = named ?? (kind === "check" ? (check ?? "check") : kind!);
    return { ...rest, id: pushFindingId({ source, key, text: found.text }), source, recheckable: said ?? LEGACY_RECHECKABLE.has(kind ?? ""), key };
};

// What `project` owes, as its push Red holds it.
export const owedIn = (state: PushChecksState, project: string): readonly StoredFinding[] => state.reds[project]?.findings ?? [];

export const openCount = (state: PushChecksState, project: string): number => owedIn(state, project).length;

// THE ONE STREAK RULE (contract, nextStreak) over a project's push red: after an observation at `at` that leaves
// `findings` owed, anything owed continues the red (or begins one), nothing owed ends it. `decided` joins its decisions.
const observed = (state: PushChecksState, project: string, findings: readonly StoredFinding[], at: number, decided: readonly MainlineRouting[] = []): PushChecksState => {
    const previous = state.reds[project];
    const streak = nextStreak(previous === undefined ? undefined : { since: previous.since, count: 1 }, findings.length > 0, at);
    const { [project]: _red, ...reds } = state.reds;
    const { [project]: _ended, ...ended } = state.ended;
    if (streak === undefined) {
        return previous === undefined
            ? state
            : { ...state, reds, ended: { ...ended, [project]: { ...previous, findings: [], decisions: [...previous.decisions, ...decided] } } };
    }
    const red: PushRed = {
        suspects: previous?.suspects ?? [],
        named: previous?.named ?? false,
        since: streak.since,
        findings: [...findings],
        decisions: [...(previous?.decisions ?? []), ...decided],
    };
    // A red that begins has nothing to undo into: the one that ended before it is history.
    return { ...state, reds: { ...reds, [project]: red }, ended: previous === undefined ? ended : state.ended };
};

// What the measurement says of one source: its own entry, or the linter as the first reports measured it.
const measureOf = (measured: PushMeasured, source: string): z.infer<typeof CheckMeasureSchema> | undefined =>
    measured.checks[source] ?? (source === "lint" && measured.lint !== undefined ? { ok: measured.lint === "passed", measured: true, keys: [] } : undefined);

// What a measurement says of one owed finding: gone, still there, or nothing (it did not measure what found it). Only a
// recheckable finding can be measured again; one about commits already pushed ends only when dismissed.
const verdictOf = (finding: StoredFinding, measured: PushMeasured): "gone" | "standing" | undefined => {
    if (!finding.recheckable) {
        return undefined;
    }
    const measure = measureOf(measured, finding.source);
    if (measure === undefined || !measure.measured) {
        return undefined;
    }
    return measure.ok || (finding.key !== "" && !measure.keys.includes(finding.key)) ? "gone" : "standing";
};

// When each finding was last brought in by a push of the project: a measurement speaks only about what was found at or
// before it.
const foundAtIn = (pushes: readonly StoredPush[], project: string): ReadonlyMap<string, number> => {
    const found = new Map<string, number>();
    for (const push of pushes.filter((each) => each.project === project)) {
        for (const finding of push.findings) {
            found.set(finding.id, Math.max(found.get(finding.id) ?? push.at, push.at));
        }
    }
    return found;
};

// What one step over the file did: the state after it, and how many owed findings it found gone.
export interface Measured {
    readonly state: PushChecksState;
    readonly resolved: number;
}

// What a dismissal (or its undo) did: the state after it, and how many findings it moved.
export interface Dismissal {
    readonly state: PushChecksState;
    readonly changed: number;
}

export interface Tally {
    // Findings this measurement found gone.
    readonly resolved: number;
    // Findings still owed in the project afterwards.
    readonly open: number;
}

// Resolves every owed finding in `project` the measurement no longer prints, of those found at or before it.
export const applyMeasured = (
    state: PushChecksState,
    project: string,
    measured: PushMeasured | undefined,
    at: number,
): Measured => {
    const owed = owedIn(state, project);
    if (measured === undefined || owed.length === 0) {
        return { state, resolved: 0 };
    }
    const found = foundAtIn(state.pushes, project);
    const gone = owed.filter((finding) => (found.get(finding.id) ?? Number.NEGATIVE_INFINITY) <= at && verdictOf(finding, measured) === "gone");
    if (gone.length === 0) {
        return { state, resolved: 0 };
    }
    const ids = gone.map((finding) => finding.id);
    const decision: MainlineRouting = { kind: "resolved", at, findings: ids, detail: "A later measurement no longer printed them." };
    return { state: observed(state, project, owed.filter((finding) => !ids.includes(finding.id)), at, [decision]), resolved: gone.length };
};

// The newest pushes, plus any older one that brought in a finding still owed, up to the cap.
export const retained = (state: PushChecksState): PushChecksState => {
    const owed = (project: string): ReadonlySet<string> => new Set(owedIn(state, project).map((finding) => finding.id));
    const pushes = state.pushes
        .filter((push, index) => index < PUSHES_KEPT || push.findings.some((finding) => owed(push.project).has(finding.id)))
        .slice(0, PUSHES_CAP);
    return pushes.length === state.pushes.length ? state : { ...state, pushes };
};

const seenWith = (state: PushChecksState, id: string): PushChecksState => ({ ...state, seen: [id, ...state.seen.filter((each) => each !== id)].slice(0, SEEN_KEPT) });

// By when each was checked, so a push filed late (its remote-tracking ref moved after a later one's) sits in its place.
const withPush = (state: PushChecksState, push: StoredPush): PushChecksState => ({
    ...state,
    pushes: [push, ...state.pushes].toSorted((left, right) => right.at - left.at),
});

// Files a push report that reached the remote: what it measured applied to what the project already owed, then what it
// found that is not owed already, which the project owes from now.
export const ingestPush = (
    state: PushChecksState,
    project: string,
    report: PushReportEntry,
): Measured => {
    const first = report.pushes?.[0];
    if (first === undefined || state.pushes.some((push) => push.project === project && push.id === report.id)) {
        return ingestMeasurement(state, project, report);
    }
    const { state: measured, resolved } = applyMeasured(state, project, report.measured, report.at);
    const owed = owedIn(measured, project);
    const standing = new Set(owed.map((finding) => finding.id));
    const findings: StoredFinding[] = [];
    for (const finding of (report.findings ?? []).map(storedFindingOf)) {
        if (!standing.has(finding.id)) {
            standing.add(finding.id);
            findings.push(finding);
        }
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
    const filed = observed(withPush(measured, push), project, [...owed, ...findings], report.at);
    return { state: seenWith(retained(filed), report.id), resolved };
};

// A measurement that files no push (a recheck, or a push the remote refused): what it measured still stands.
export const ingestMeasurement = (
    state: PushChecksState,
    project: string,
    report: PushReportEntry,
): Measured => {
    const { state: measured, resolved } = applyMeasured(state, project, report.measured, report.at);
    return { state: seenWith(measured, report.id), resolved };
};

// A PUSH THE REPOSITORY'S OWN HOOK REFUSED. Nothing reached the remote, so no report of this sandbox's tooling was filed
// for it (a hook of any repository may refuse); the daemon files it here itself, as a push marked `refused` whose one
// finding is what the hook printed, owed by the project's push red like every other, so the owner's hand-over
// (conversations/fix/push-fix.ts) reads it from the same place.
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

// What every refused push in the project left owed, settled: a later push answered for the same work, passing or refused
// again. Returns the state unchanged (by reference) when nothing was.
export const settleRefusals = (state: PushChecksState, project: string, at: number): PushChecksState => {
    const refused = new Set(
        state.pushes.filter((push) => push.project === project && push.refused === true).flatMap((push) => push.findings.map((finding) => finding.id)),
    );
    const owed = owedIn(state, project);
    const settled = owed.filter((finding) => refused.has(finding.id)).map((finding) => finding.id);
    if (settled.length === 0) {
        return state;
    }
    const decision: MainlineRouting = { kind: "resolved", at, findings: settled, detail: "A later push of the same work answered the refusal." };
    return observed(state, project, owed.filter((finding) => !settled.includes(finding.id)), at, [decision]);
};

// Files one refusal, settling any the project had before it.
export const fileRefusal = (state: PushChecksState, project: string, refusal: PushRefusal): PushChecksState => {
    const tail = refusal.output.trim().slice(-REFUSAL_TAIL);
    const text = tail === "" ? "the pre-push hook refused the push without saying why" : tail;
    const finding: StoredFinding = {
        id: pushFindingId({ source: REFUSAL_SOURCE, key: "", text }),
        source: REFUSAL_SOURCE,
        // Only the hook passing answers it, and that is a push: it settles then, never at a measurement.
        recheckable: false,
        text,
        command: "git push --dry-run",
        key: "",
    };
    const push: StoredPush = {
        project,
        id: `refused-${refusal.at.toString(36)}`,
        at: refusal.at,
        ...opt("remote", refusal.remote),
        ...opt("branch", refusal.branch),
        head: refusal.head,
        commits: 0,
        refused: true,
        findings: [finding],
    };
    const settled = settleRefusals(state, project, refusal.at);
    const owed = owedIn(settled, project).filter((each) => each.id !== finding.id);
    return retained(observed(withPush(settled, push), project, [...owed, finding], refusal.at));
};

// The newest copy each push of the project filed of each finding: what a dismissed one is opened again from.
const bodiesIn = (state: PushChecksState, project: string): ReadonlyMap<string, StoredFinding> => {
    const bodies = new Map<string, StoredFinding>();
    for (const push of state.pushes.filter((each) => each.project === project)) {
        for (const finding of push.findings.filter((each) => !bodies.has(each.id))) {
            bodies.set(finding.id, finding);
        }
    }
    return bodies;
};

// Sets owed findings aside as a decision on the project's push red, the named ones (every one owed when none is named),
// or opens named dismissed ones again. An undo opens only what a dismissal of this red (or of the one that just ended)
// names, and nothing owed already: the owed copy stands for it.
export const dismissIn = (
    state: PushChecksState,
    project: string,
    ids: readonly string[] | undefined,
    restore: boolean,
    now: number,
): Dismissal => {
    const owed = owedIn(state, project);
    if (!restore) {
        const dismissed = owed.filter((finding) => ids === undefined || ids.includes(finding.id)).map((finding) => finding.id);
        if (dismissed.length === 0) {
            return { state, changed: 0 };
        }
        const decision: MainlineRouting = { kind: "dismissed", at: now, findings: dismissed };
        return { state: observed(state, project, owed.filter((finding) => !dismissed.includes(finding.id)), now, [decision]), changed: dismissed.length };
    }
    const red = state.reds[project] ?? state.ended[project];
    if (red === undefined || ids === undefined) {
        return { state, changed: 0 };
    }
    const standing = new Set(owed.map((finding) => finding.id));
    const set = new Set(red.decisions.flatMap((decision) => (decision.kind === "dismissed" ? (decision.findings ?? []) : [])));
    const bodies = bodiesIn(state, project);
    const reopened = [...new Set(ids)].filter((id) => set.has(id) && !standing.has(id)).flatMap((id) => {
        const body = bodies.get(id);
        return body === undefined ? [] : [body];
    });
    if (reopened.length === 0) {
        return { state, changed: 0 };
    }
    const back = new Set(reopened.map((finding) => finding.id));
    // The undone dismissal never stood: its ids leave the decision, and a decision left naming none goes.
    const decisions = red.decisions.flatMap((decision) => {
        if (decision.kind !== "dismissed" || decision.findings === undefined) {
            return [decision];
        }
        const left = decision.findings.filter((id) => !back.has(id));
        return left.length === 0 ? [] : [{ ...decision, findings: left }];
    });
    const { [project]: _ended, ...ended } = state.ended;
    return {
        state: { ...state, reds: { ...state.reds, [project]: { ...red, findings: [...owed, ...reopened], decisions } }, ended },
        changed: reopened.length,
    };
};

// A decision about the whole of a project's push red (a hand-over to an agent), filed on it; nothing when none stands.
export const decidedIn = (state: PushChecksState, project: string, decision: MainlineRouting): PushChecksState => {
    const red = state.reds[project];
    return red === undefined ? state : { ...state, reds: { ...state.reds, [project]: { ...red, decisions: [...red.decisions, decision] } } };
};

const publicFinding = ({ key: _key, ...finding }: StoredFinding) => finding;

// Every push as the wire carries it: the keys the store names findings by stay here.
export const publicPushes = (pushes: readonly StoredPush[]): MainlinePush[] => pushes.map((push) => ({ ...push, findings: push.findings.map(publicFinding) }));

// Every project's push red as the wire carries it, one Red whatever went red.
export const publicPushReds = (reds: Readonly<Record<string, PushRed>>): Red[] =>
    Object.entries(reds)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([scope, red]) => ({ source: "push", scope, ...red, findings: red.findings.map(publicFinding) }));

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
    // Files a decision about the project's push red as a whole (who it was handed to).
    readonly decide: (project: string, decision: MainlineRouting) => Promise<void>;
}

export const filePushChecksStore = (path: string): PushChecksStore => {
    const file = openDocument<typeof pushChecksDocument, PushChecksState>(pushChecksDocument, path, {
        unknownKeys: true,
        fallback: () => ({ pushes: [], reds: {}, ended: {}, seen: [] }),
    });
    const tallied =
        (
            step: (state: PushChecksState, project: string, report: PushReportEntry) => Measured,
        ) =>
        async (project: string, report: PushReportEntry): Promise<Tally> => {
            let resolved = 0;
            const written = await file.update((current) => {
                const next = step(current, project, report);
                resolved = next.resolved;
                return next.state;
            });
            return { resolved, open: openCount(written, project) };
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
        decide: async (project, decision) => {
            await file.update((current) => decidedIn(current, project, decision));
        },
    };
};
