// Platform-session invalidation has several authoritative sources: an explicit sign-out, a confirmed empty
// Better Auth session, a protected platform RPC's 401, or another tab doing one of those. They all enter here
// so the signed-in shell, daemon connections, in-memory credentials, and persisted caches fall together.
type InvalidationListener = () => void | Promise<void>;

const listeners = new Set<InvalidationListener>();
const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.platform-auth`);

export const onPlatformAuthInvalidated = (listener: InvalidationListener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const invalidatePlatformAuth = async (broadcast = true): Promise<void> => {
    if (broadcast) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
        channel?.postMessage(`invalidated`);
    }
    await Promise.all([...listeners].map((listener) => listener()));
};

if (channel !== undefined) {
    channel.addEventListener(`message`, () => void invalidatePlatformAuth(false));
}
