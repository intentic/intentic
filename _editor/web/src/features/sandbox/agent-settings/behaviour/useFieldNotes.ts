import { type FieldNotesStatus, FieldNotesStatusSchema } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { sandboxJson } from "../../client/sandboxClient";
import { SANDBOX_FIELD_NOTES } from "../../../../lib/queryKeys";
import { useSandboxQuery } from "../../client/useSandboxQuery";

/* The state of this sandbox's field notes: whether there is a brief, how much of it the budget reaches, and whether
   anything is scheduled to rewrite it. Its own route rather than a settings field, because none of it is a choice
   anyone made — it is read off the file and the automation store every time it is asked for. */

export function useFieldNotes(): { status: ComputedRef<FieldNotesStatus | undefined>; refetch: () => void } {
    const { query } = useSandboxQuery({
        queryKey: computed(() => SANDBOX_FIELD_NOTES.of()),
        queryFn: async (): Promise<FieldNotesStatus> => FieldNotesStatusSchema.parse(await sandboxJson(`/settings/field-notes`)),
    });
    return {
        status: computed<FieldNotesStatus | undefined>(() => query.data.value),
        refetch: () => void query.refetch(),
    };
}
