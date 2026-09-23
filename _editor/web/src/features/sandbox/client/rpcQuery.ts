import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { rpcKey, rpcKeyAt } from "../../../lib/queryKeys";
import { UNPERSISTED } from "../../../lib/queryPersistence";
import { type ProcedureInput, type ProcedureName, type ProcedureOutput, type SandboxCallContext, sandboxRpc } from "./sandboxRpc";

// A contract read as a vue-query entry: the key derived from the procedure and its input (queryKeys.ts says how), and
// a fetch of exactly that procedure with exactly that input, so no read declares a key or a route of its own.

export interface RpcQueryOptions {
    // Another sandbox by id, or a getter for one; the key names that box in place of the active one.
    readonly at?: MaybeRefOrGetter<string | undefined>;
    // Memory only, never the persisted mirror (queryPersistence's storage rule): the answer runs to hundreds of KB.
    readonly unpersisted?: boolean;
    // Nobody is waiting on it: the fetch never raises a sign-in (SandboxCallContext).
    readonly background?: boolean;
}

// A procedure named by its route name, on the client the app calls; typed by the name, reached by walking it.
const callProcedure = <N extends ProcedureName>(
    procedure: N,
    input: ProcedureInput<N>,
    context: SandboxCallContext,
): Promise<ProcedureOutput<N>> => {
    const [group = ``, name = ``] = procedure.split(`.`);
    const groups = sandboxRpc as unknown as Readonly<Record<string, Readonly<Record<string, (input: unknown, options: unknown) => Promise<unknown>>>>>;
    return groups[group]![name]!(input, { context }) as Promise<ProcedureOutput<N>>;
};

// The input a read takes, optional where the procedure's is, and reactive where the caller's is.
type ReadArguments<N extends ProcedureName> = undefined extends ProcedureInput<N>
    ? [input?: MaybeRefOrGetter<ProcedureInput<N>>, options?: RpcQueryOptions]
    : [input: MaybeRefOrGetter<ProcedureInput<N>>, options?: RpcQueryOptions];

export const rpcQuery = <N extends ProcedureName>(
    procedure: N,
    ...[input, options = {}]: ReadArguments<N>
): { readonly queryKey: ComputedRef<unknown[]>; readonly queryFn: () => Promise<ProcedureOutput<N>> } => {
    const marks = options.unpersisted === true ? [UNPERSISTED] : [];
    return {
        queryKey: computed(() => {
            const at = toValue(options.at);
            return at === undefined ? rpcKey(procedure, toValue(input), ...marks) : rpcKeyAt(at, procedure, toValue(input), ...marks);
        }),
        queryFn: () => {
            const at = toValue(options.at);
            return callProcedure(procedure, toValue(input) as ProcedureInput<N>, {
                ...(at === undefined ? {} : { at }),
                ...(options.background === true ? { background: true } : {}),
            });
        },
    };
};
