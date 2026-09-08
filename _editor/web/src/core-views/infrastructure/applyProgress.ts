import { describeProvisionError } from "./provisionError";

// Pure reducer of the apply event stream into per-resource progress; kept separate from the composable (which
// owns the ref, daemon calls, terminal poll) so it's unit-testable against a fabricated stream, including a
// mid-stream cut and replay.

export interface ApplyNode {
    readonly id: string;
    readonly type?: string;
    readonly state: `start` | `done`;
    readonly action?: string;
    readonly reason?: string;
}

export interface ApplyReadiness {
    readonly id: string;
    readonly state: `waiting` | `ready`;
    readonly url?: string;
}

export interface ApplyIteration {
    readonly n: number;
    readonly converged: boolean;
}

export interface ApplyPrune {
    readonly id: string;
    readonly type?: string;
    readonly state: string;
    readonly reason?: string;
}

export interface ApplyOrphan {
    readonly id: string;
    readonly type?: string;
}

export interface ApplyProgressState {
    readonly nodes: ReadonlyMap<string, ApplyNode>;
    readonly readiness: ReadonlyMap<string, ApplyReadiness>;
    readonly iterations: readonly ApplyIteration[];
    readonly prunes: readonly ApplyPrune[];
    readonly orphans: readonly ApplyOrphan[];
    readonly converged?: boolean;
    // apply's {kind:"exit",command:"apply"} arrived; the per-resource phase ended (adopt may still run).
    readonly applyPhaseDone: boolean;
    // The whole apply→adopt job ended (adopt's exit, or a failed apply's); evidence-based, the poll is a fallback.
    readonly jobDone: boolean;
    readonly error?: string;
}

export const initialApplyState = (): ApplyProgressState => ({
    nodes: new Map(),
    readiness: new Map(),
    iterations: [],
    prunes: [],
    orphans: [],
    converged: undefined,
    applyPhaseDone: false,
    jobDone: false,
    error: undefined,
});

const str = (value: unknown): string | undefined => (typeof value === `string` ? value : undefined);

// Folds one apply-events line into state. {kind:"start"} resets for a clean replay after refresh; {kind:"exit"}
// marks the phase done and records a generic failure message when none exists yet. Unknown kinds pass through.
export const reduceApplyLine = (state: ApplyProgressState, line: Record<string, unknown>): ApplyProgressState => {
    const kind = line[`kind`];
    if (kind === `start`) {
        return initialApplyState();
    }
    if (kind === `node` && line[`phase`] === `apply`) {
        const id = str(line[`id`]);
        if (id === undefined) {
            return state;
        }
        const existing = state.nodes.get(id);
        const nodes = new Map(state.nodes);
        nodes.set(id, {
            id,
            type: str(line[`type`]) ?? existing?.type,
            state: line[`state`] === `done` ? `done` : `start`,
            action: str(line[`action`]) ?? existing?.action,
            reason: str(line[`reason`]) ?? existing?.reason,
        });
        return { ...state, nodes };
    }
    if (kind === `readiness`) {
        const id = str(line[`id`]);
        if (id === undefined) {
            return state;
        }
        const readiness = new Map(state.readiness);
        readiness.set(id, { id, state: line[`state`] === `ready` ? `ready` : `waiting`, url: str(line[`url`]) });
        return { ...state, readiness };
    }
    if (kind === `iteration`) {
        const n = typeof line[`n`] === `number` ? (line[`n`] as number) : state.iterations.length + 1;
        const converged = line[`converged`] === true;
        return { ...state, iterations: [...state.iterations, { n, converged }], converged };
    }
    if (kind === `prune`) {
        const id = str(line[`id`]);
        if (id === undefined) {
            return state;
        }
        return {
            ...state,
            prunes: [...state.prunes, { id, type: str(line[`type`]), state: str(line[`state`]) ?? `deleted`, reason: str(line[`reason`]) }],
        };
    }
    if (kind === `orphan`) {
        const id = str(line[`id`]);
        if (id === undefined) {
            return state;
        }
        return { ...state, orphans: [...state.orphans, { id, type: str(line[`type`]) }] };
    }
    if (kind === `result`) {
        return typeof line[`converged`] === `boolean` ? { ...state, converged: line[`converged`] as boolean } : state;
    }
    if (kind === `error`) {
        return { ...state, error: describeProvisionError(str(line[`message`]) ?? `Apply failed.`) };
    }
    if (kind === `exit`) {
        const command = str(line[`command`]);
        const code = line[`code`];
        const failed = typeof code === `number` && code !== 0;
        const label = command === `adopt` ? `Adopt` : command === `resolve` ? `Resolve` : `Apply`;
        return {
            ...state,
            // The chain may be `apply && adopt` or `resolve && apply && adopt`: resolve's clean exit is only a
            // preamble,
            // and the phase/job end on adopt's exit, an untagged exit, or any command's failure.
            applyPhaseDone: state.applyPhaseDone || command !== `resolve` || failed,
            jobDone: state.jobDone || command === `adopt` || command === undefined || failed,
            error: state.error ?? (failed ? `${label} failed, open the logs below for details.` : undefined),
        };
    }
    return state;
};
