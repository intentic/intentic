import { type AutomationApproval, AutomationApprovalsListSchema } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { host } from "./host";

/* THE APPROVAL QUEUE, named once for both of its readers: the view's list and the rail badge's background poll
 * (attention.ts). One sandbox-scoped key and one parser, so whichever of them asks first fills the entry the
 * other paints from, which is the whole reason a HostQuery exists rather than a fetch beside each reader.
 *
 * No `staleTime`: the manifest points `.intentic/records/approvals/` at this key, so a wake being held, approved
 * or rejected invalidates it within the watcher's own batch. Anything the push misses is caught by the poll's
 * interval, and asking again for an answer a file write has already contradicted is the one thing that must not
 * happen here: the count means "waiting for a yes", and a stale one is the badge asking for a yes twice. */
export const approvalsQuery = (): HostQuery<AutomationApproval[]> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`automation-approvals`),
        queryFn: async (): Promise<AutomationApproval[]> =>
            AutomationApprovalsListSchema.parse(await api.sandbox.json(`/automations/pending`)).approvals,
    };
};

/* WHICH HELD WAKES ACTUALLY WANT A PERSON. A hold with an `autoRunAt` is only a DELAY: the scheduler releases it
 * itself when the clock gets there, and nobody has to do anything. A `requireApproval` hold has no such deadline
 * and moves only when the owner says so, which is the one the rail may speak for. Counting both would put a
 * number on the tile for something that is about to happen on its own. */
export const owedOf = (approvals: readonly AutomationApproval[]): readonly AutomationApproval[] =>
    approvals.filter((approval) => approval.autoRunAt === undefined);
