// `ic sandbox fix --json` as This device draws it (src/device/fix.ts; src-tauri/src/fix.rs runs it). Its stdout
// carries machine lines only: progress as `intentic-fix: {json}` while it works, then one `{"slug", "report"}` line per
// sandbox at the end; its words for people go to stderr. The report is the api contract's HostReportInput. Everything
// in it is read leniently, since the progress line is younger than this app: a line that is neither shape is passed
// over, and a state, a fix, an outcome or a check id this app has never heard of is kept as the string it is.

/** One link of the chain `ic` checks, as the view holds it: the latest `ic` said about that id. */
export interface FixCheck {
    readonly id: string;
    /** The check's name as `ic` prints it; its id when it gave none. */
    readonly label: string;
    /** `ok`, `warn`, `fail`, `fixing` or `skip` today; empty when no line has said yet. */
    readonly state: string;
    /** On warn and fail: what is wrong, and what closes it, in the user's terms. */
    readonly problem?: string;
    readonly remedy?: string;
    /** Who can close it: `auto`, `consent` (`ic` can, once someone says yes) or `you`. */
    readonly fix?: string;
}

/** A report as one line carries it. A progress line may carry only what changed, so every field is optional. */
export interface FixReportPart {
    readonly stage?: string;
    readonly doing?: string;
    readonly outcome?: string;
    readonly checks?: readonly FixCheckPart[];
}

/** A check as one line carries it: only its id is sure to be there. */
export interface FixCheckPart {
    readonly id: string;
    readonly label?: string;
    readonly state?: string;
    readonly problem?: string;
    readonly remedy?: string;
    readonly fix?: string;
}

/** A line of `ic`'s stdout that is part of its report: `progress` while it works, `final` once per sandbox at the end. */
export interface FixLine {
    readonly kind: `progress` | `final`;
    readonly slug?: string;
    readonly report: FixReportPart;
}

/** How the run ended, as the app's command answers (fix.rs `FixEnd`). */
export interface FixEnd {
    /** `ic`'s exit code: 0 healthy or fixed, 1 something left, 3 a consent with no terminal, 4 a restart or sign-out. */
    readonly code: number | null;
    /** It ran past the app's limit and was stopped. */
    readonly timedOut: boolean;
}

const PROGRESS = `intentic-fix: `;

/** What `JSON.parse` gives back, spelled out so a line is read as what it is. */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonFields;
interface JsonFields {
    readonly [key: string]: JsonValue;
}

const parseJson = (text: string): JsonValue | undefined => {
    try {
        // SAFETY: JSON.parse returns nothing but JSON values, which is all JsonValue says.
        return JSON.parse(text) as JsonValue;
    } catch {
        // allow(silent-catch): a line cut short (the pipe closed mid-write) is not worth a broken screen; the next one says more.
        return undefined;
    }
};

const isFields = (value: JsonValue | undefined): value is JsonFields => typeof value === `object` && value !== null && !Array.isArray(value);
const isList = (value: JsonValue | undefined): value is readonly JsonValue[] => Array.isArray(value);
// An empty string says nothing, so it is read as nothing said.
const isText = (value: JsonValue | undefined): value is string => typeof value === `string` && value !== ``;
const textOf = (value: JsonValue | undefined): string | undefined => (isText(value) ? value : undefined);

const checkOf = (value: JsonValue): FixCheckPart | undefined => {
    // A check with no id cannot be kept apart from the others, or said yes to.
    if (!isFields(value) || !isText(value[`id`])) {
        return undefined;
    }
    return {
        id: value[`id`],
        label: textOf(value[`label`]),
        state: textOf(value[`state`]),
        problem: textOf(value[`problem`]),
        remedy: textOf(value[`remedy`]),
        fix: textOf(value[`fix`]),
    };
};

const reportOf = (fields: JsonFields): FixReportPart => {
    const checks = fields[`checks`];
    return {
        stage: textOf(fields[`stage`]),
        doing: textOf(fields[`doing`]),
        outcome: textOf(fields[`outcome`]),
        checks: isList(checks) ? checks.map(checkOf).filter((check) => check !== undefined) : undefined,
    };
};

/** Read one stdout line; undefined for anything that is not part of the report. */
export const parseFixLine = (line: string): FixLine | undefined => {
    const text = line.trim();
    if (text.startsWith(PROGRESS)) {
        const payload = parseJson(text.slice(PROGRESS.length));
        if (!isFields(payload)) {
            return undefined;
        }
        // `{ slug?, report }`, or the report itself with its fields at the top.
        const wrapped = payload[`report`];
        return { kind: `progress`, slug: textOf(payload[`slug`]), report: reportOf(isFields(wrapped) ? wrapped : payload) };
    }
    if (text.startsWith(`{`)) {
        const payload = parseJson(text);
        const report = isFields(payload) ? payload[`report`] : undefined;
        if (!isFields(payload) || !isFields(report)) {
            return undefined;
        }
        return { kind: `final`, slug: textOf(payload[`slug`]), report: reportOf(report) };
    }
    return undefined;
};

/** Everything the view draws of one run. */
export interface FixView {
    /** The sandbox this run is for: a line naming another is someone else's. */
    readonly slug: string;
    readonly stage?: string;
    readonly doing?: string;
    readonly outcome?: string;
    /** In the order `ic` first named them; the final report's order once it has arrived. */
    readonly checks: readonly FixCheck[];
    /** A line of the report has been read: the `ic` that ran knows `sandbox fix --json`. */
    readonly reported: boolean;
    /** The final report has arrived. */
    readonly final: boolean;
    /** The last few lines `ic` wrote on stderr: the evidence when it had no report to give. */
    readonly said: readonly string[];
    readonly end?: FixEnd;
}

/** How many stderr lines are kept. */
export const SAID_KEPT = 6;

export const startFix = (slug: string): FixView => ({ slug, checks: [], reported: false, final: false, said: [] });

const merged = (previous: FixCheck | undefined, next: FixCheckPart): FixCheck => ({
    id: next.id,
    label: next.label ?? previous?.label ?? next.id,
    state: next.state ?? previous?.state ?? ``,
    problem: next.problem,
    remedy: next.remedy,
    fix: next.fix,
});

// Latest by id, each where it first appeared: a check that goes from `fail` to `fixing` to `ok` stays on its row.
const withChecks = (held: readonly FixCheck[], incoming: readonly FixCheckPart[]): FixCheck[] => {
    const checks = [...held];
    for (const check of incoming) {
        const at = checks.findIndex((seen) => seen.id === check.id);
        if (at === -1) {
            checks.push(merged(undefined, check));
        } else {
            checks[at] = merged(checks[at], check);
        }
    }
    return checks;
};

const applied = (view: FixView, line: FixLine): FixView => {
    const { report } = line;
    const final = line.kind === `final`;
    // The final report is the whole of it, so its checks replace the list rather than joining it.
    const kept = final && report.checks !== undefined ? [] : view.checks;
    return {
        ...view,
        stage: report.stage ?? view.stage,
        // A line naming its stage is a new moment of the run, so what it is doing is what that line says (nothing, when
        // it says nothing); a line with no stage leaves it as it was unless it says otherwise.
        doing: report.stage === undefined ? (report.doing ?? view.doing) : report.doing,
        outcome: report.outcome ?? view.outcome,
        checks: withChecks(kept, report.checks ?? []),
        reported: true,
        final: view.final || final,
    };
};

/** Fold one line of the run into the view. */
export const foldFixLine = (view: FixView, stream: `stdout` | `stderr`, text: string): FixView => {
    if (stream === `stderr`) {
        return text.trim() === `` ? view : { ...view, said: [...view.said, text].slice(-SAID_KEPT) };
    }
    const line = parseFixLine(text);
    if (line === undefined || (line.slug !== undefined && line.slug !== view.slug)) {
        return view;
    }
    return applied(view, line);
};

export const endFix = (view: FixView, end: FixEnd): FixView => ({ ...view, end });

/** Where a run has got to, as the verdict under the checks says it. */
export type FixVerdict =
    | { readonly kind: `running` }
    /** It ended having reported nothing: an `ic` from before `sandbox fix`, or one that could not run it. */
    | { readonly kind: `unsupported` }
    /** The app stopped it at its limit. */
    | { readonly kind: `stopped` }
    | {
          readonly kind: `ended`;
          /** The report's word (`healthy`, `fixed`, `needs-you`, `failed`, or one this app does not know). */
          readonly outcome?: string;
          readonly code: number | null;
          /** What the exit code says is left: a restart or sign-out (4), or a yes nobody could give in a terminal (3). */
          readonly next?: `restart` | `consent`;
      };

export const EXIT_CONSENT = 3;
export const EXIT_RESTART = 4;

export const verdictOf = (view: FixView): FixVerdict => {
    const { end } = view;
    if (end === undefined) {
        return { kind: `running` };
    }
    if (end.timedOut) {
        return { kind: `stopped` };
    }
    if (!view.reported) {
        return { kind: `unsupported` };
    }
    const next: `restart` | `consent` | undefined = end.code === EXIT_RESTART ? `restart` : end.code === EXIT_CONSENT ? `consent` : undefined;
    return { kind: `ended`, code: end.code, outcome: view.outcome, next };
};

/** A check id as `ic` names them, on its way to `--accept`: a plain token nothing reads as a flag (fix.rs `is_check_id`). */
export const isCheckId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);

/** The checks `ic` can close once the user says yes, each a button once the run has ended. */
export const consentChecks = (view: FixView): FixCheck[] =>
    view.end === undefined ? [] : view.checks.filter((check) => check.fix === `consent` && isCheckId(check.id));

/** Problem and remedy are drawn only where something is wrong. */
export const troubled = (check: FixCheck): boolean => check.state === `warn` || check.state === `fail`;
