import { z } from "zod";
import { reloadOnHotUpdate } from "../app/hotReload";

// Platform-session invalidation has several authoritative sources: an explicit sign-out, a confirmed empty
// Better Auth session, a protected platform RPC's 401, or another tab doing one of those. They all enter here
// so the signed-in shell, daemon connections, in-memory credentials, and persisted caches fall together.
//
// The same channel says when another tab moved this browser to a different account (switched, added one, signed one out
// and carried on as the next): the cookie every tab rides is the browser's, so every tab follows it
// (accounts/accountBoundary.ts).
type InvalidationListener = () => void | Promise<void>;
type AccountChangedListener = (account: string | undefined) => void;

type LifecycleMessage = `invalidated` | { readonly kind: `account-changed`; readonly account: string | null };

const listeners = new Set<InvalidationListener>();
const accountListeners = new Set<AccountChangedListener>();
const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.platform-auth`);

export const onPlatformAuthInvalidated = (listener: InvalidationListener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const invalidatePlatformAuth = async (broadcast = true): Promise<void> => {
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
        channel?.postMessage(`invalidated` satisfies LifecycleMessage);
    }
    await Promise.all([...listeners].map((listener) => listener()));
};

/** Tells every other tab this browser is now on `account` (undefined: nobody's). This tab acts on its own move itself. */
export const announceAccountChanged = (account: string | undefined): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
    channel?.postMessage({ kind: `account-changed`, account: account ?? null } satisfies LifecycleMessage);
};

/** Hears another tab move this browser to another account. */
export const onAccountChangedElsewhere = (listener: AccountChangedListener): (() => void) => {
    accountListeners.add(listener);
    return () => accountListeners.delete(listener);
};

// What another tab may say: anything that is not an account change is the invalidation, as every build before said it.
const AccountChangedSchema = z.object({ kind: z.literal(`account-changed`), account: z.string().nullable() });

if (channel !== undefined) {
    channel.addEventListener(`message`, (event: MessageEvent<unknown>) => {
        const changed = AccountChangedSchema.safeParse(event.data);
        if (changed.success) {
            for (const listener of accountListeners) {
                listener(changed.data.account ?? undefined);
            }
            return;
        }
        void invalidatePlatformAuth(false);
    });
}

// One channel and one set of listeners per window: a hot update that re-ran this module would leave another
// tab's sign-out landing on listeners this window's shell no longer holds (hotReload.ts).
reloadOnHotUpdate(import.meta);
