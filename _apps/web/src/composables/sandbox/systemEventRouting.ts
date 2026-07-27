/* What a daemon `/events` frame makes STALE — the routing policy, with no store, query client, or Vue in
 * sight. It used to be inlined in the reconnect loop, which meant the module that owns backoff and watchdogs
 * also owned the manifest→query table, and neither could be exercised without the other.
 *
 * Keeping it dependency-free is the point: these are the rules a cross-user cache-freshness bug lives in, and
 * they are now readable and testable on their own. The dispatcher that ACTS on them is systemEvents.ts. */

// Which .intentic/ manifest backs which queries. The daemon-internal churn under .intentic/ (its iq index, the
// agent transcripts) is unwatched at the source now, but this stays a per-file map rather than a prefix test:
// one stray write under .intentic/ must never cost every one of these queries a refetch — that amplification is
// what turned an index rebuild into an endless request storm. Prefixes, so environment.{,custom.,approved.}
// Dockerfile and the one-file-per-approval dir each match with a single entry.
const MANIFEST_QUERIES: readonly { readonly prefix: string; readonly keys: readonly string[] }[] = [
    // A capability add/remove recomposes the environment overlay and can add or drop a repo's panel.
    { prefix: `.intentic/capabilities.json`, keys: [`capabilities`, `environment`, `panels`] },
    { prefix: `.intentic/environment.`, keys: [`environment`] },
    { prefix: `.intentic/automations.json`, keys: [`automations`] },
    { prefix: `.intentic/approvals/`, keys: [`automation-approvals`] },
    { prefix: `.intentic/settings.json`, keys: [`settings`] },
];

// The query keys a batch of changed paths makes stale, deduped. Cross-user freshness for the .intentic/-backed
// views: another member's capability/automation/setting write lands here as a plain file change, but those
// queries only refetch on their OWN mutations — so without this every connected browser would sit on state the
// sandbox has already moved past until it remounted.
export const manifestQueryKeys = (paths: readonly string[]): readonly string[] => [
    ...new Set(MANIFEST_QUERIES.filter(({ prefix }) => paths.some((path) => path.startsWith(prefix))).flatMap(({ keys }) => keys)),
];

// The persisted-cache key for a sandbox's workspace identity.
const workspaceIdKey = (sandboxId: string): string => `intentic.workspaceId.${sandboxId}`;

// Does this hello frame describe a DIFFERENT workspace than the one we cached for this sandbox? A workspace is
// wiped and recreated under the SAME sandbox id by cleanup.sh + reconnect, so the id alone cannot detect it and
// the persisted cache would paint the previous workspace's tree over an empty /work. Records the identity
// either way, so the first hello after a wipe is the only one that reports true.
export const workspaceReplaced = (sandboxId: string, workspaceId: string): boolean => {
    const known = localStorage.getItem(workspaceIdKey(sandboxId));
    localStorage.setItem(workspaceIdKey(sandboxId), workspaceId);
    return known !== null && known !== workspaceId;
};

// Every query cached for one sandbox. The sandbox id is the LAST key element (sandboxKey appends it), so
// prefix matching cannot scope this — a predicate is the only way to reach exactly one sandbox's entries.
export const sandboxQueryPredicate =
    (sandboxId: string) =>
    (query: { readonly queryKey: readonly unknown[] }): boolean =>
        query.queryKey.at(-1) === sandboxId;
