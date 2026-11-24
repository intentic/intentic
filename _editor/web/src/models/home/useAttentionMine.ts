import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { type SandboxScope, useSandboxScope } from "../../client/sandbox/scope/useSandboxScope";
import type { ProcedureOutput } from "../../client/sandbox/sandboxRpc";
import { perSandbox } from "../../client/sandbox/scope/perSandbox";
import { AMBIENT_READ, UNPERSISTED } from "../../lib/queryPersistence";
import { onScreen } from "../../workbench/window/onScreen";

// HOW MUCH THE SANDBOX THIS COMPONENT STANDS IN HOLDS FOR ITS READER, as one Home tile's badge counts it: the nearest
// `<InSandbox>`'s sandbox, or the active one outside any. The same cache entry useHomeAttention.ts reads for that sandbox,
// so a tile and the rail around it ask the daemon once between them.

// Between two reads while a tile is on screen: Home's own pace (useHomeAttention.ts).
const ATTENTION_EVERY_MS = 15_000;

// How long one reader's answer serves another without asking again: just under a poll, so two readers on the same pace
// share each read and a slower one (the sandbox rail's door to Home) rides the faster one's.
export const ATTENTION_SHARED_MS = ATTENTION_EVERY_MS - 1_000;

// Memory only, as these counts always were: a tile never paints a count from before the page loaded.
export const attentionKey = (scope: SandboxScope): unknown[] => scope.key(`agents.attentionMine`, undefined, UNPERSISTED);

type Attention = ProcedureOutput<`agents.attentionMine`>;

// The last call made to each sandbox, answered or not. Every reader's fetch goes through it (attentionRead), so within
// ATTENTION_SHARED_MS of one call every other reader takes its outcome, a failure included: an asleep sandbox is asked
// once a poll, however many readers it has, where a failure alone would leave the cache entry stale and let each reader
// call again.
interface LastCall {
    at: number;
    answer: Promise<Attention> | undefined;
}
const lastCall = perSandbox((): LastCall => ({ at: 0, answer: undefined }));

/**
 * One read of sandbox `scope`'s attention, or the outcome of the call another reader made less than ATTENTION_SHARED_MS
 * ago; `fresh` asks again regardless (a connection that just came up).
 */
export const attentionRead = (scope: SandboxScope, fresh = false): Promise<Attention> => {
    const id = scope.id.value;
    if (id === undefined) {
        return scope.rpc.agents.attentionMine();
    }
    const last = lastCall.of(id);
    const now = Date.now();
    if (!fresh && last.answer !== undefined && now - last.at < ATTENTION_SHARED_MS) {
        return last.answer;
    }
    last.at = now;
    last.answer = scope.rpc.agents.attentionMine();
    return last.answer;
};

// What every read of the entry carries: an ambient glance at another sandbox, never retried or reported when it sleeps
// (queryPersistence.ts AMBIENT_READ), whichever reader made it.
export const ATTENTION_QUERY = { meta: AMBIENT_READ, retry: false } as const;

export const useAttentionMine = () => {
    const scope = useSandboxScope();
    return useSandboxQuery(
        {
            ...scope.query(`agents.attentionMine`, undefined, { unpersisted: true }),
            ...ATTENTION_QUERY,
            // Through the same gate as Home's readings, so the tile's interval and Home's poll make one call between them.
            queryFn: () => attentionRead(scope),
            refetchInterval: ATTENTION_EVERY_MS,
            staleTime: ATTENTION_SHARED_MS,
            // Asked only while a window shows it, as Home's readings are.
            enabled: onScreen,
        },
        scope.at,
    );
};
