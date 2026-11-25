import { sandboxRef } from "@intentic/extension-api";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { type Placement, PlacementQuerySchema } from "@intentic/sandbox-contract/schemas/providers/capacity";
import type { z } from "zod";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { advertisesRoute } from "../../../client/sandbox/useDaemonRoutes";
import { rpcPrefix } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { providerCapacities } from "../providerAccounts";

/* WHERE THE DAEMON WOULD RUN A TURN NAMING NO ACCOUNT, asked of the daemon rather than worked out here. The window used to
   predict it from the verdicts alone (plan-pools.ts preferredAccount), while the daemon places a Claude turn with the
   fan-out planner, which also counts what already runs on each account: while children crowded the account renewing
   first, the turn went to the next one and the picker still ticked the first (2026-11-15, -17; 6f17a56c52 and a4d769e38e
   each moved the prediction closer, and neither could see the load). The daemon now answers the question itself with the
   same function the turn uses: each provider's capacity carries its pick for a turn naming no model (`placement`), and
   `usage.placement` answers it for the turn this person would send, on the loop the chat runs on and among the accounts
   they may run on (`narrowed`). A daemon from before either has no answer, and the window's own prediction stands in for
   it (servingAccount.ts autoAccount); one from before `loop` answers the sandbox-wide pick, which stands in only where
   this person's rows hold it. */

/**
 * The daemon's answer: the account it would place the turn on (none where it has no choice to make), or not in yet.
 * `narrowed`: placed on this person's loop and accounts, so the window takes it as is.
 */
export type DaemonPlacement =
    | { readonly kind: `placed`; readonly account: string | undefined; readonly narrowed?: true | undefined }
    | { readonly kind: `pending` };

// Moves with every change to a placement read in the cache (asked, answered, failed, invalidated, collected), so a
// computed reading one is read again when it does: the cache entry under its rpcKey is the answer, this only says when it
// moved.
// Subscribed on the first question, not as the module loads: nothing listens before anybody asks, and a module that
// subscribes as it is imported reaches the cache wherever it is imported, a suite's stand-in for it included.
const placementsMoved = sandboxRef(() => 0);
const PLACEMENT = rpcPrefix(`usage.placement`)[0];
let listening = false;
const listen = (): void => {
    if (listening) {
        return;
    }
    listening = true;
    queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] === PLACEMENT) {
            placementsMoved.value += 1;
        }
    });
};

type PlacementQuery = z.infer<typeof PlacementQuerySchema>;

// The question as asked: a turn naming no model, or no loop, leaves the key out. A daemon from before `loop` drops it
// from the query and answers as it always did.
const placementQuery = (provider: AgentProvider, model: string, loop: string | undefined): PlacementQuery => {
    const query: PlacementQuery = { provider };
    if (model !== ``) {
        query.model = model;
    }
    if (loop !== undefined) {
        query.loop = loop;
    }
    return query;
};

const placementRead = (provider: AgentProvider, model: string, loop: string | undefined) =>
    rpcQuery(`usage.placement`, placementQuery(provider, model, loop), { unpersisted: true, background: true });

/** The cache entry the daemon's answer for `provider`, `model` and `loop` is filed under (rpcKey, in the active sandbox). */
export const placementKey = (provider: AgentProvider, model: string, loop?: string): unknown[] => placementRead(provider, model, loop).queryKey.value;

/**
 * Where a turn naming no account would run on `provider` and `model` (empty: the turn names none) and `loop` (the one
 * the chat runs on), as the daemon places it for the person asking; undefined against a daemon whose hello does not name
 * `usage.placement`, which leaves the window's own prediction. Reactive: read in a computed, it moves when the answer
 * lands and when a capacity frame for the provider says the answer may have moved (placementsMoved). A question nobody
 * asked yet, or whose answer a capacity frame staled, is asked once, outside the computed that read it.
 */
export const daemonPlacement = (provider: AgentProvider, model: string, loop?: string): DaemonPlacement | undefined => {
    // compat(daemon<1.428.0): the usage.placement route
    if (!advertisesRoute(`usage.placement`)) {
        return undefined;
    }
    listen();
    void placementsMoved.value;
    const read = placementRead(provider, model, loop);
    const key = read.queryKey.value;
    const state = queryClient.getQueryState<Placement>(key);
    if (state === undefined || (state.isInvalidated && state.fetchStatus === `idle`)) {
        // After the computed reading this has finished: the ask writes the cache, which moves placementsMoved, which that
        // computed depends on. A failed ask is the cache's to log, and stays failed until a frame stales it.
        queueMicrotask(() => {
            // allow(silent-catch): queryPersistence logs every read that finally failed; the window's prediction stands meanwhile.
            queryClient.fetchQuery({ queryKey: key, queryFn: read.queryFn, staleTime: Number.POSITIVE_INFINITY }).catch(() => undefined);
        });
    }
    const answer = state?.data;
    if (answer?.narrowed === true) {
        return { kind: `placed`, account: answer.account, narrowed: true };
    }
    // Until that answer lands, and against a daemon from before `loop`, a turn naming no model is the capacity's own pick,
    // judged with everything else the daemon sent for the provider: the sandbox-wide one, as the older answer is.
    const capacity = model === `` ? providerCapacities.value[provider] : undefined;
    if (capacity !== undefined) {
        return { kind: `placed`, account: capacity.placement };
    }
    return answer === undefined ? { kind: `pending` } : { kind: `placed`, account: answer.account };
};

/**
 * A capacity frame for `provider` arrived: anything under it moved, so every placement asked of it is read again by the
 * next surface that shows one. Marked rather than fetched, so a provider nobody is looking at costs nothing.
 */
export const placementsStale = (provider: string): void => {
    void queryClient.invalidateQueries({
        queryKey: [PLACEMENT],
        // The question each entry was asked, read back off its key (rpcKey files the input second).
        predicate: (query) => PlacementQuerySchema.safeParse(query.queryKey[1]).data?.provider === provider,
        refetchType: `none`,
    });
};
