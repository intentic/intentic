import type { FieldNotesStatus } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../client/rpcQuery";
import { useSandboxQuery } from "../../client/useSandboxQuery";

/* The state of this sandbox's field notes: whether there is a brief, how much of it the budget reaches, and whether
   anything is scheduled to rewrite it. Its own route rather than a settings field, because none of it is a choice
   anyone made — it is read off the file and the automation store every time it is asked for. */

export function useFieldNotes(): { status: ComputedRef<FieldNotesStatus | undefined>; refetch: () => void } {
    const { query } = useSandboxQuery(rpcQuery(`settings.fieldNotes`));
    return {
        status: computed<FieldNotesStatus | undefined>(() => query.data.value),
        refetch: () => void query.refetch(),
    };
}
