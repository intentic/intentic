import type { StatusVariant } from "@intentic/ui";
import { readIntenticLines } from "../intenticStream";

/* The shared reconcile-action vocabulary, used everywhere the resolve → plan → apply pipeline surfaces a
 * per-resource verdict: the live-status board (status.json statuses + a live `intentic deploy plan`), the infra
 * change preview (a pre-apply `intentic deploy plan`), and the live apply progress (the apply event stream). One
 * source of truth for the label text, badge variant, and node dot colour so the graph, the details panel, the
 * preview, and the progress list stay in lockstep. Its cross-extension home is here beside useWorkspaceState /
 * useDeployments, the other infra read-model pieces both extensions share. */

// Where a verdict is rendered decides its wording: the live board frames the gap between desired and reality
// ("Drift"); a plan/apply frames what the run will do ("Update"). Same underlying action, two readings.
export type ReconcileContext = `live` | `plan`;

// How one reconcile action reads on every surface at once. A row per action rather than a branch per surface:
// the four readings below are four views of the SAME verdict, and splitting them into four if-chains is what
// let a new action arrive with a label and no dot colour. `diff` and `prune` are the daemon's older spellings
// of `update` and `delete` and share their rows verbatim.
interface Reading {
    readonly live: string;
    readonly plan: string;
    readonly variant: StatusVariant;
    readonly dot: string;
    // Present-continuous for an apply node still in flight (kind:"node" state:"start"): "Creating…", "Updating…".
    readonly gerund: string;
}

const CREATE: Reading = { live: `To create`, plan: `Create`, variant: `info`, dot: `bg-info`, gerund: `Creating` };
const UPDATE: Reading = { live: `Drift`, plan: `Update`, variant: `info`, dot: `bg-info`, gerund: `Updating` };
const REMOVE: Reading = { live: `To remove`, plan: `Remove`, variant: `danger`, dot: `bg-danger`, gerund: `Removing` };

// An action nothing here recognises. Named rather than neutral: `unknown` is the daemon SAYING it could not
// read the resource, which is worth its own muted treatment, while an action we simply have no row for is
// still a change of some sort, so it keeps the info colouring and only its wording gives up.
const UNREADABLE: Reading = { live: `Unknown`, plan: `Unknown`, variant: `neutral`, dot: `bg-subtle`, gerund: `Working` };
const UNRECOGNISED: Reading = { live: `Unknown`, plan: `Unknown`, variant: `info`, dot: `bg-info`, gerund: `Working` };

const READINGS: Record<string, Reading> = {
    noop: { live: `In sync`, plan: `No change`, variant: `success`, dot: `bg-success`, gerund: `Working` },
    create: CREATE,
    update: UPDATE,
    diff: UPDATE,
    delete: REMOVE,
    prune: REMOVE,
    unknown: UNREADABLE,
};

const readingOf = (status: string): Reading => READINGS[status] ?? UNRECOGNISED;

export const statusLabel = (status: string, context: ReconcileContext = `live`): string => readingOf(status)[context];

export const statusVariant = (status: string): StatusVariant => readingOf(status).variant;

// The reconcile status as a dot color, the same semantics as statusVariant's DOT palette.
export const statusDot = (status: string): string => readingOf(status).dot;

export const statusGerund = (status: string): string => readingOf(status).gerund;

// One resource's verdict from an `intentic deploy plan` stream (kind:"node"): the resource id + its reconcile action.
export interface PlanStep {
    readonly id: string;
    readonly action: string;
    readonly reason?: string;
}

// A live resource that exists but is absent from the desired graph (the plan `result` frame's orphan list),
// what a subsequent `apply --yes` would remove.
export interface PlanOrphan {
    readonly id: string;
    readonly type?: string;
}

// The daemon serializes orphans as { id, type } objects; tolerate a bare-string id too so a shape change can't
// silently drop them (the previous string-only filter always yielded []).
const readOrphans = (value: unknown): PlanOrphan[] => {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((entry): PlanOrphan[] => {
        if (typeof entry === `string`) {
            return [{ id: entry }];
        }
        if (typeof entry === `object` && entry !== null && typeof (entry as { id?: unknown }).id === `string`) {
            const orphan = entry as { id: string; type?: unknown };
            return [{ id: orphan.id, ...(typeof orphan.type === `string` ? { type: orphan.type } : {}) }];
        }
        return [];
    });
};

// Live narration from a running plan: which node is being read (its kind:"node" state:"start" event) or the
// last provider log line (the orphan scan narrates per provider; connect failures land here too), what a
// consumer shows instead of a blank spinner, and what a stall watchdog re-arms on. `terminal` is the tmux
// session the run executes in visibly (the stream's first frame), the caller surfaces its tab.
export interface PlanProgress {
    readonly node?: string;
    readonly log?: string;
    readonly terminal?: string;
}

// Reduce a daemon `intentic deploy plan` SSE stream (read + diff, no apply) to its per-resource verdicts + orphan list.
// A terminal kind:"error" frame (a non-zero CLI exit, normalized by readIntenticLines) throws so the caller
// surfaces the reason instead of showing an empty plan.
export const readPlanSteps = async (
    body: ReadableStream<Uint8Array>,
    onProgress?: (progress: PlanProgress) => void,
): Promise<{ steps: PlanStep[]; orphans: PlanOrphan[] }> => {
    const steps: PlanStep[] = [];
    let orphans: PlanOrphan[] = [];
    for await (const line of readIntenticLines(body)) {
        if (line[`kind`] === `node`) {
            const id = line[`id`];
            const action = line[`action`];
            const reason = line[`reason`];
            if (line[`state`] === `start` && typeof id === `string`) {
                onProgress?.({ node: id });
            } else if (typeof id === `string` && typeof action === `string`) {
                steps.push({ id, action, ...(typeof reason === `string` ? { reason } : {}) });
            }
        } else if (line[`kind`] === `log`) {
            const message = line[`message`];
            if (typeof message === `string`) {
                onProgress?.({ log: message });
            }
        } else if (line[`kind`] === `terminal`) {
            const session = line[`session`];
            if (typeof session === `string`) {
                onProgress?.({ terminal: session });
            }
        } else if (line[`kind`] === `result`) {
            orphans = readOrphans(line[`orphans`]);
        } else if (line[`kind`] === `error`) {
            const message = line[`message`];
            throw new Error(typeof message === `string` ? message : `The plan check failed.`);
        }
    }
    return { steps, orphans };
};

// The one-line "does the last apply match the current desired state" pill. undefined before the first apply
// (status.json's `converged` is absent), so callers render nothing.
export const convergedBadge = (converged: boolean | undefined): { label: string; variant: StatusVariant } | undefined => {
    if (converged === undefined) {
        return undefined;
    }
    return converged ? { label: `Up to date`, variant: `success` } : { label: `Changes pending`, variant: `info` };
};
