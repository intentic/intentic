import { type ProcedureInput, type ProcedureName, type ProcedureOutput, type SandboxCallContext, type SandboxRpc, sandboxRpc } from "../sandboxRpc";

// The app's one client, aimed at a sandbox: every call goes through `sandboxRpc` itself with `at` (and the pace the scope
// sets) in its context, read at CALL time, so a scope whose id moves aims its next call anew, and a suite that replaces
// `sandboxRpc` by module (`vi.mock(".../sandboxRpc")`) sees every scope's calls in its fake. A call's own context wins.

// What one call carries beside its input, as every procedure of the client takes it.
interface CallOptions {
    readonly context?: SandboxCallContext;
}
// One procedure as this layer holds it: input and answer are typed by the contract at the facade and only passed through.
type Procedure = (input: ProcedureInput<ProcedureName>, options?: CallOptions) => Promise<ProcedureOutput<ProcedureName>>;
type Client = Readonly<Record<string, Readonly<Record<string, Procedure>>>>;

interface AimedPace {
    // Nobody is waiting on these calls (SandboxCallContext.background).
    readonly background?: boolean;
}

// What a scope adds to a call's context, built a field at a time so an absent one is never written as undefined.
interface Aim {
    at?: string;
    background?: true;
}

// The context a call goes with: the scope's aim and pace, under the call's own.
const contextOf = (aim: string | undefined, background: boolean | undefined, own: SandboxCallContext | undefined): SandboxCallContext => {
    const context: Aim = {};
    if (aim !== undefined) {
        context.at = aim;
    }
    if (background === true) {
        context.background = true;
    }
    return { ...context, ...own };
};

export const aimedRpc = (at: () => string | undefined, { background }: AimedPace = {}): SandboxRpc => {
    const group = (name: string) =>
        new Proxy(
            {},
            {
                get: (_target, procedure) => (input: ProcedureInput<ProcedureName>, options: CallOptions = {}) => {
                    // SAFETY: looked up at call time, never captured, so a replaced client still answers; the facade lets
                    // a caller spell only the groups and procedures the contract names, each of which `sandboxRpc` serves.
                    const client = sandboxRpc as unknown as Client;
                    return client[name]![String(procedure)]!(input, { ...options, context: contextOf(at(), background, options.context) });
                },
            },
        );
    // SAFETY: the proxy answers every group the contract names with a proxy answering each of its procedures, which is
    // the shape SandboxRpc types.
    return new Proxy({}, { get: (_target, name) => group(String(name)) }) as SandboxRpc;
};
