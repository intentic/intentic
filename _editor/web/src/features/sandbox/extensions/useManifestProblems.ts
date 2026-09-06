import { type ManifestProblemReport, ManifestProblemsSchema, type ManifestRepair } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { queryClient } from "../../../lib/queryPersistence";
import { MANIFESTS, SANDBOX_SETTINGS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

/* WHAT THE SANDBOX COULDN'T READ IN ITS OWN SETTINGS FILES.
 *
 * The daemon keeps its state as small JSON files, reads each through a schema, and falls back to defaults when
 * the schema says no. Falling back is right, it must boot with a broken settings file, but it used to be the
 * whole story, and all three ways of being broken reach a user identically: the feature is just off.
 *
 *   • the file won't parse, so EVERY setting in it is at its default;
 *   • one key is misspelled, so that one setting silently never applies;
 *   • one entry of a list was skipped, so a capability or persona quietly vanished from its picker.
 *
 * The daemon now records all three as it reads, and this is the browser's view of that record.
 *
 * The query key is `manifests`, which the workspace-state table lists against every one of those files, so
 * the daemon's existing file watcher is what refreshes this. Fixing the typo on disk clears the notice by
 * itself: no polling, no dismiss button, nothing to go stale. */

const QUERY_KEY = MANIFESTS.of();

export function useManifestProblems() {
    const { query } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<ManifestProblemReport[]> => ManifestProblemsSchema.parse(await sandboxJson(`/system/manifest-problems`)),
    });

    // Empty until the daemon answers, which is also what an older daemon without the route leaves it as, the
    // notice is additive, so a sandbox that cannot report simply shows nothing rather than an error.
    const reports = computed<ManifestProblemReport[]>(() => query.data.value ?? []);
    const hasProblems = computed(() => reports.value.length > 0);

    return { reports, hasProblems, repair };
}

/* TAKE ONE STRAY KEY OUT, the acting half of the read above, and the reason this notice has buttons on it at
 * all: the daemon has already named the key and guessed the spelling, so what is left is an edit with nothing
 * to decide. Throws the daemon's own sentence on a refusal, which for two of the four is a race worth reading
 * ("it looks like it has already been fixed") rather than a failure.
 *
 * MODULE-LEVEL, not inside the composable, for the reason the read is a shared query: this mutates a file, and
 * a per-caller copy would be per-caller only in the sense that each would invalidate the same two keys.
 *
 * BOTH KEYS, and the settings one is not belt-and-braces. A REMOVE changes nothing the settings page can see —
 * the schema had already stripped that key on the way in — but a RENAME makes a value the page renders appear
 * out of nowhere, and a page still showing the old parse would sit there contradicting the file until something
 * else refetched it. */
const repair = async (request: ManifestRepair): Promise<void> => {
    await sandboxJson(`/system/manifest-problems/repair`, jsonBody(`POST`, request));
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SANDBOX_SETTINGS.of() }),
    ]);
};
