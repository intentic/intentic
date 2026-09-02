import { type AutomationApproval, AutomationApprovalsListSchema } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* THE OTHER QUEUE THIS PAGE DRAWS: automations held at the door. A `requireApproval` automation fired, and the
 * daemon parked the wake in `.intentic/records/approvals/` instead of running it (automations/held-wakes-store.ts);
 * a `holdForSeconds` one is parked the same way under a countdown the daemon releases itself.
 *
 * IT IS AN APPROVAL BY THE PAGE'S OWN TEST, the trigger prepared an exact wake, the owner's yes releases it, the
 * daemon runs precisely that wake, and it used to live on the Automations page, badging a tile in the "Set up"
 * band for a decision that belongs in "Judge". Every "waiting for your yes" now counts in one place and is
 * answered from one place.
 *
 * WHY IT IS NOT THE SAME STORE. An agent-authored approval is versioned in the root repo: small, kept afterwards,
 * meant to be read. A held wake is daemon-minted, consumed on release, and snapshots a trigger payload that may be
 * anything a webhook sent, none of which belongs in git history. Two stores, two routes, one page: the owner sees
 * one queue, and the daemon keeps writing each record where it belongs.
 *
 * No `staleTime`: the manifest points `.intentic/records/approvals/` at this key, so a wake being held, approved
 * or rejected invalidates it within the watcher's own batch. Asking again for an answer a file write has already
 * contradicted is the one thing that must not happen here: the count means "waiting for a yes", and a stale one
 * is the badge asking for a yes twice. */
export const heldWakesQuery = (): HostQuery<AutomationApproval[]> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`automation-approvals`),
        queryFn: async (): Promise<AutomationApproval[]> =>
            AutomationApprovalsListSchema.parse(await api.sandbox.json(`/automations/pending`)).approvals,
    };
};

/* WHICH HELD WAKES ACTUALLY WANT A PERSON. A hold with an `autoRunAt` is only a DELAY: the scheduler releases it
 * itself when the clock gets there, and nobody has to do anything. A `requireApproval` hold has no such deadline
 * and moves only when the owner says so, which is the one the badge may speak for. Counting both would put a
 * number on the tile for something that is about to happen on its own. */
export const waitingOf = (held: readonly AutomationApproval[]): readonly AutomationApproval[] => held.filter((wake) => wake.autoRunAt === undefined);

export function useHeldWakes() {
    const api = host();
    const queryClient = useQueryClient();
    const spec = heldWakesQuery();
    const { data, error, isLoading } = useQuery({
        ...spec,
        enabled: computed(() => api.sandbox.reachable()),
    });
    // Releasing a wake records a run on its automation, so the Automations page's list moves too. Invalidated by
    // name rather than owned: that key belongs to the automations extension, and this only says it went stale.
    const invalidate = (): Promise<void> => {
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`automations`) });
        return queryClient.invalidateQueries({ queryKey: spec.queryKey });
    };

    const approve = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/pending/${encodeURIComponent(id)}/approve`, { method: `POST` }),
        onSuccess: invalidate,
    });
    const reject = useMutation({
        mutationFn: (id: string) => api.sandbox.json(`/automations/pending/${encodeURIComponent(id)}/reject`, { method: `POST` }),
        onSuccess: invalidate,
    });

    return {
        held: computed<AutomationApproval[]>(() => data.value ?? []),
        error: computed(() => error.value?.message),
        isLoading,
        approve,
        reject,
    };
}
