import type { SandboxReach } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import { useQueries, useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { ACCOUNT_ORGS } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { apiClient } from "../../../lib/useApi";
import { type AccountGraph, buildAccountGraph, type ReachRead } from "./accountGraph";
import { readStateOf, stillOf } from "./readState";

// EVERY SANDBOX THE ACCOUNT REACHES, ASKED WHAT IT IS TIED TO. The platform's list says which sandboxes the account is in;
// each of them answers GET /system/reach under the reader's own session there, the editor being the one party signed in
// to all of them (the reason pairing two sandboxes is the editor's job too, links.md). The answers are joined in
// accountGraph.ts.
//
// Access changes while nobody looks: an owner narrows a tier, revokes a link, unpairs a computer. So each answer is a
// reading with a time on it. It is read when the page opens, again every few minutes while it stays open and when the
// window comes back, and kept (in the account's own persisted cache) so a sandbox that cannot be asked now is drawn as
// it last answered, marked by why. Nothing here wakes a sleeping sandbox: an asleep one is drawn as of its last answer,
// and opening it is the reader's choice. Nobody waits on these reads, so none of them raises a sign-in; a sandbox with
// no session to read it under offers a press that asks in the foreground.

/** Reads older than this are asked again when the page is next drawn. */
const FRESH_MS = 60_000;
/** While the page stays open, every sandbox is asked again this often. */
const REREAD_MS = 5 * 60_000;

const reachQuery = (sandboxId: string, background: boolean) => rpcQuery(`system.reach`, undefined, { at: sandboxId, background });

export function useAccountReach() {
    const { sandboxes, refresh: refreshList } = useSandbox();
    const { user } = useAuth();

    const orgs = useQuery(
        {
            queryKey: ACCOUNT_ORGS.every,
            queryFn: async () => (await apiClient.org.list()).orgs.map((org) => ({ id: org.id, name: org.name, role: org.role })),
            staleTime: REREAD_MS,
        },
        queryClient,
    );

    const reads = useQueries(
        {
            queries: computed(() =>
                sandboxes.value.map((sandbox) => ({
                    ...reachQuery(sandbox.id, true),
                    enabled: stillOf(sandbox) === undefined,
                    staleTime: FRESH_MS,
                    refetchInterval: REREAD_MS,
                    refetchOnWindowFocus: true,
                    retry: false,
                })),
            ),
        },
        queryClient,
    );

    const readMap = computed(() => {
        const map = new Map<string, ReachRead>();
        sandboxes.value.forEach((sandbox, index) => {
            const query = reads.value[index];
            const answer: SandboxReach | undefined = query?.data;
            map.set(sandbox.id, { state: readStateOf(sandbox, { fetching: query?.isFetching === true, error: query?.error ?? null, answer }), answer });
        });
        return map;
    });

    const graph = computed<AccountGraph>(() =>
        buildAccountGraph({
            email: user.value?.email ?? ``,
            orgs: orgs.data.value ?? [],
            sandboxes: sandboxes.value,
            reads: readMap.value,
        }),
    );

    /** Asks every sandbox again, and the platform for the list, now. */
    const reread = async (): Promise<void> => {
        await refreshList();
        await Promise.all([
            orgs.refetch(),
            ...sandboxes.value
                .filter((sandbox) => stillOf(sandbox) === undefined)
                .map((sandbox) => queryClient.refetchQueries({ queryKey: reachQuery(sandbox.id, true).queryKey.value, exact: true })),
        ]);
    };

    /** Reads one sandbox in the foreground, where signing in to it may ask the reader: the press a `signin` card offers. */
    const readNow = async (sandboxId: string): Promise<void> => {
        const foreground = reachQuery(sandboxId, false);
        await queryClient.fetchQuery({ queryKey: foreground.queryKey.value, queryFn: foreground.queryFn, staleTime: 0 });
    };

    const reading = computed(() => [...readMap.value.values()].some((read) => read.state === `reading`));

    return { graph, reads: readMap, reading, reread, readNow };
}
