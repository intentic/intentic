// What a daemon `/events` frame makes stale: the routing policy, dependency-free (no store, query client, or Vue), so
// it's testable on its own. The dispatcher that acts on these rules is systemEvents.ts.

// Which manifest backs which queries now lives once in @intentic/sandbox-contract (workspace-state.ts).

// Both identity checks follow one rule: record every hello, report change only against a known value.
const identityKey = (kind: string, sandboxId: string): string => `intentic.${kind}.${sandboxId}`;

const changedSince = (kind: string, sandboxId: string, current: string | undefined): boolean => {
    // Nothing advertised, from a daemon predating the field: leave the remembered value alone.
    if (current === undefined) {
        return false;
    }
    const known = localStorage.getItem(identityKey(kind, sandboxId));
    localStorage.setItem(identityKey(kind, sandboxId), current);
    return known !== null && known !== current;
};

// Whether this hello describes a different workspace; a wipe-and-recreate keeps the same sandbox id.
export const workspaceReplaced = (sandboxId: string, workspaceId: string): boolean => changedSince(`workspaceId`, sandboxId, workspaceId);

// Whether this is a different daemon build than the one cached; stale-while-revalidate is safe across a restart, wrong
// across a rebuild, firing once per production update and on every dev rebuild.
export const daemonRebuilt = (sandboxId: string, build: string | undefined): boolean => changedSince(`daemonBuild`, sandboxId, build);

// Every per-sandbox key naming this sandbox's id, dropped on replacement except the identity records above.
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

// Every query cached for one sandbox; the id is the last key element, so a prefix match can't scope this.
export const sandboxQueryPredicate =
    (sandboxId: string) =>
    (query: { readonly queryKey: readonly unknown[] }): boolean =>
        query.queryKey.at(-1) === sandboxId;
