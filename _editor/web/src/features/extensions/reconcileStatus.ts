import type { StatusVariant } from "@intentic/ui";
import { readIntenticLines } from "../../lib/intenticStream";

// Shared reconcile-action vocabulary for the live-status board, the plan preview, and apply progress: one source of
// truth for a verdict's label, badge variant, and dot colour so all three stay in lockstep.

// Where a verdict renders decides its wording: the live board frames it as drift from desired state ("Drift"), a
// plan/apply frames it as an action ("Update").
export type ReconcileContext = `live` | `plan`;

// One row per action, read by every surface, rather than a branch per surface. `diff` and `prune` are the daemon's
// older spellings of `update` and `delete` and share their rows.
interface Reading {
    readonly live: string;
    readonly plan: string;
    readonly variant: StatusVariant;
    readonly dot: string;
    // Present-continuous for an apply node still in flight (kind:"node" state:"start"): "Creating…", "Updating…".
    readonly gerund: string;
}

const CREATE: Reading = { live: `to create`, plan: `create`, variant: `info`, dot: `bg-info`, gerund: `creating` };
const UPDATE: Reading = { live: `drift`, plan: `update`, variant: `info`, dot: `bg-info`, gerund: `updating` };
const REMOVE: Reading = { live: `to remove`, plan: `remove`, variant: `danger`, dot: `bg-danger`, gerund: `removing` };

// `unknown` is the daemon's own signal; an unrecognised action keeps info colour, only its wording gives up.
const UNREADABLE: Reading = { live: `unknown`, plan: `unknown`, variant: `neutral`, dot: `bg-subtle`, gerund: `working` };
const UNRECOGNISED: Reading = { live: `unknown`, plan: `unknown`, variant: `info`, dot: `bg-info`, gerund: `working` };

const READINGS: Record<string, Reading> = {
    noop: { live: `in sync`, plan: `no change`, variant: `success`, dot: `bg-success`, gerund: `working` },
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

// Same colour semantics as statusVariant, rendered as a dot.
export const statusDot = (status: string): string => readingOf(status).dot;

export const statusGerund = (status: string): string => readingOf(status).gerund;

// One resource's verdict from an `intentic deploy plan` stream (kind:"node"): the resource id and its reconcile action.
export interface PlanStep {
    readonly id: string;
    readonly action: string;
    readonly reason?: string;
}

// A live resource absent from the desired graph (the plan `result` frame's orphan list); what `apply --yes` would
// remove next.
export interface PlanOrphan {
    readonly id: string;
    readonly type?: string;
}

// Orphans serialize as { id, type }; tolerate a bare-string id too so a shape change can't silently drop them.
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

// Live narration from a running plan: the node being read, the last provider log line, or the terminal session the run
// is visible in. Rendered instead of a blank spinner, and rearms the stall watchdog.
export interface PlanProgress {
    readonly node?: string;
    readonly log?: string;
    readonly terminal?: string;
}

// Reduces an `intentic deploy plan` SSE stream (read + diff, no apply) to per-resource verdicts and an orphan list. A
// terminal kind:"error" frame throws, so the caller can surface the reason instead of an empty plan.
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

// Pill for whether the last apply matches desired state. Undefined before the first apply (`converged` absent in
// status.json), so callers render nothing.
export const convergedBadge = (converged: boolean | undefined): { label: string; variant: StatusVariant } | undefined => {
    if (converged === undefined) {
        return undefined;
    }
    return converged ? { label: `up to date`, variant: `success` } : { label: `changes pending`, variant: `info` };
};
