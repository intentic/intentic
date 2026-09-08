import { type ManifestProblemReport, ManifestProblemsSchema, type ManifestRepair } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { queryClient } from "../../../lib/queryPersistence";
import { MANIFESTS, SANDBOX_SETTINGS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// What the sandbox couldn't read in its own settings files, recorded instead of just falling back to defaults:
// - the file didn't parse (everything's at default)
// - a key was misspelled (that setting never applies)
// - a list entry was skipped (an item vanished from its picker)

const QUERY_KEY = MANIFESTS.of();

export function useManifestProblems() {
    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<ManifestProblemReport[]> => ManifestProblemsSchema.parse(await sandboxJson(`/system/manifest-problems`)),
    });

    // Empty until the daemon answers, same as an older daemon with no such route; shows nothing, not an error.
    const reports = computed<ManifestProblemReport[]>(() => query.data.value ?? []);
    const hasProblems = computed(() => reports.value.length > 0);

    return { reports, hasProblems, repair };
}

// Removes one stray key the daemon already named and guessed the spelling for, a plain edit. Invalidates both the
// manifest and settings queries, since a rename can surface a value the settings page must repaint.
const repair = async (request: ManifestRepair): Promise<void> => {
    await sandboxJson(`/system/manifest-problems/repair`, jsonBody(`POST`, request));
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SANDBOX_SETTINGS.of() }),
    ]);
};
