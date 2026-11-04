import { resetSandboxScope } from "@intentic/extension-api";
import { clearImprints } from "@intentic/ui/skeleton-store";
import { announceDesktopRoster } from "../../app/environments/desktop";
import { clearAccountStorage, clearEveryAccountStorage, sealAccountWrites } from "../../app/storage/browserStorage";
import { clearPersistedQueries } from "../../lib/queryPersistence";
import { useSandboxSession } from "../session/sandboxSession";
import { useGoogleIdentity } from "./useGoogleIdentity";

// WHAT AN ACCOUNT LEAVES IN THIS BROWSER, FORGOTTEN: what a signed-out account, a session that ended, or a deleted one
// takes with it. One account's own (its drawer, its caches, its credentials: `{ account }`, the open one's by default), or
// every account's (`every`): signing out of all of them. A device preference (theme, language, layout) stays either way,
// as does what another account still signed in here holds. The account boundary decides which account a page is for
// (lib/accounts/accountBoundary.ts); this only clears.

const { clearCredential } = useGoogleIdentity();
const { clearSessions } = useSandboxSession();

/** Which accounts' traces go: one account's (the open one's when none is named), or every account's. */
export type Forgotten = { readonly account?: string } | `every`;

export const forgetAccountTraces = async (which: Forgotten = {}): Promise<void> => {
    const every = which === `every`;
    // Signed-in runtime stops first, before storage/cache cleanup, so no live daemon stream outlives the teardown. What
    // this page still writes on its way out (a snapshot on `pagehide`, a debounced draft) cannot put any of it back.
    sealAccountWrites();
    clearCredential();
    clearSessions();
    // The desktop app's local windows list this account's sandboxes from what this page told it; none are theirs now.
    announceDesktopRoster([]);
    // The remembered loading imprints are the account's sandboxes' too: how many secrets, rows, agents each one held. So
    // is everything the account left in storage (open chats, drafts, recent prompts, the transcript mirror, which
    // sandbox was open); app/storage/browserStorage.ts declares which. The extension bundles kept per sandbox
    // (extension-host/bundleCache.ts) are the sandboxes' code, no account's, and go only when every account does, deleted
    // by name: this layer may not import the host.
    // allow(silent-catch): a page with no Cache Storage (an insecure context, storage denied) kept no bundles to delete
    const bundles = every ? (async () => caches.delete(`intentic.extensionBundles`))().catch(() => false) : Promise.resolve(false);
    await Promise.all([
        clearPersistedQueries(every ? `every` : which),
        clearImprints(),
        every ? clearEveryAccountStorage() : clearAccountStorage(which.account),
        bundles,
    ]);
    // Module state that belongs to one sandbox (the open tabs, the roster, set-aside drafts, extensions' badges) is
    // emptied last, so what refills it on its next read finds the storage already cleared.
    resetSandboxScope();
};
