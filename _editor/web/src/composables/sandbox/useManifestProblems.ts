import { type ManifestProblemReport, ManifestProblemsSchema } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { MANIFESTS } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

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

    return { reports, hasProblems };
}
