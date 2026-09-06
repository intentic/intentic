/* What a daemon `/events` frame makes STALE, the routing policy, with no store, query client, or Vue in
 * sight. It used to be inlined in the reconnect loop, which meant the module that owns backoff and watchdogs
 * also owned the manifest→query table, and neither could be exercised without the other.
 *
 * Keeping it dependency-free is the point: these are the rules a cross-user cache-freshness bug lives in, and
 * they are now readable and testable on their own. The dispatcher that ACTS on them is systemEvents.ts. */

/* Which .intentic/ manifest backs which queries used to be declared HERE, in a copy maintained separately from
 * the paths the daemon actually writes, and the two drifted: `.intentic/config/approvals/` is written by the agent's own
 * file tools and rendered by the Approvals view, and was simply never added. It now lives once in
 * @intentic/sandbox-contract (workspace-state.ts), where both sides derive from it; callers import
 * `staleQueryKeys` from there directly. */

/* The two identities a hello frame carries that the persisted cache is only valid against, each remembered per
 * sandbox. Both follow one rule: RECORD on every hello and report a change only against something previously
 * known, so a first-ever connection is never mistaken for a change and the hello after one is the only one
 * that reports true. */
const identityKey = (kind: string, sandboxId: string): string => `intentic.${kind}.${sandboxId}`;

const changedSince = (kind: string, sandboxId: string, current: string | undefined): boolean => {
    // Nothing advertised: a daemon that predates the field, which we cannot interrogate and must not punish,
    // leave the remembered value alone so a later daemon that DOES advertise still compares against it.
    if (current === undefined) {
        return false;
    }
    const known = localStorage.getItem(identityKey(kind, sandboxId));
    localStorage.setItem(identityKey(kind, sandboxId), current);
    return known !== null && known !== current;
};

// Does this hello frame describe a DIFFERENT workspace than the one we cached for this sandbox? A workspace is
// wiped and recreated under the SAME sandbox id by cleanup.sh + reconnect, so the id alone cannot detect it and
// the persisted cache would paint the previous workspace's tree over an empty /work.
export const workspaceReplaced = (sandboxId: string, workspaceId: string): boolean => changedSince(`workspaceId`, sandboxId, workspaceId);

/* Is this a different BUILD of the daemon than the one whose answers we cached? The response shapes are the
 * daemon's to change, and the browser paints its IndexedDB-persisted copies stale-while-revalidate on the next
 * load, right across restarts of one daemon, wrong across a rebuild into another. Hydrating an old build's
 * payloads into components written for the new one is what made `pnpm build:sandbox && dev-sandbox.sh` leave a
 * workspace that only a site-data wipe would fix.
 *
 * In production this fires once per sandbox update, which is exactly when it should; in dev it fires on every
 * rebuild, which is exactly what a developer changing those shapes needs. The cost either way is one refetch,
 * the reconnect was already going to invalidate the tree. */
export const daemonRebuilt = (sandboxId: string, build: string | undefined): boolean => changedSince(`daemonBuild`, sandboxId, build);

/* Everything this browser REMEMBERS about one sandbox's workspace, dropped when the hello says the workspace
 * was replaced: the editor tabs and open folders, the chat tab snapshot, terminal cosmetics, the commit draft,
 * the input history, all of it names paths, sessions or conversations in a /work that no longer exists.
 *
 * Membership is the id in the key: every module that remembers per-sandbox state keys its blob with the
 * sandbox id (`intentic.workspaceTabs.<id>`, `ui-terminal-meta-<id>`, …), so a substring sweep stays correct
 * as new ones appear, the alternative was a hand-maintained key list, which is the SCHEMA_VERSION mistake
 * with more entries. Both storages, because windowStore mirrors each blob into sessionStorage as this window's
 * authoritative copy. The two identity records above are the exception: they were just rewritten with the NEW
 * workspace's values, and sweeping them would make the next hello read this change as a first-ever contact. */
const IDENTITY_PREFIXES = [`intentic.workspaceId.`, `intentic.daemonBuild.`];

export const dropSandboxLocalState = (sandboxId: string): void => {
    for (const storage of [(): Storage => localStorage, (): Storage => sessionStorage]) {
        try {
            const store = storage();
            const doomed = Object.keys(store).filter((key) => key.includes(sandboxId) && !IDENTITY_PREFIXES.some((prefix) => key.startsWith(prefix)));
            for (const key of doomed) {
                store.removeItem(key);
            }
        } catch {
            // Unavailable (private mode, site data off), then nothing was remembered to drop.
        }
    }
};

// Every query cached for one sandbox. The sandbox id is the LAST key element (sandboxKey appends it), so
// prefix matching cannot scope this, a predicate is the only way to reach exactly one sandbox's entries.
export const sandboxQueryPredicate =
    (sandboxId: string) =>
    (query: { readonly queryKey: readonly unknown[] }): boolean =>
        query.queryKey.at(-1) === sandboxId;
