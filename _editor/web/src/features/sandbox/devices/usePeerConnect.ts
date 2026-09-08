import { ref, shallowRef } from "vue";
import { onRuntimeChanged } from "../live/runtimeEvents";
import { sandboxRequest } from "../client/sandboxClient";

// Drives Connect for a peer capability (host or browser) sharing one door shape. Connect mints a single-use
// token bound to this capability; the door pushes a runtime-change event on pairing, so the card updates
// without a timer. The token is shown once and never stored.
export interface PeerDoor {
    // The path segment this door is served under: /system/<slug>, /system/<slug>/pair, /system/<slug>/:id.
    readonly slug: "hosts" | "webext";
    // The runtime-change domain the daemon announces the door's liveness on.
    readonly domain: "hosts" | "webext";
    // The key the roster answers under.
    readonly listKey: "hosts" | "browsers";
    readonly noun: string;
}

export function usePeerConnect<Summary extends { readonly id: string; readonly online: boolean }>(door: PeerDoor) {
    // Shallow: the roster is replaced whole on each read; a deep ref would unwrap the generic Summary type.
    const peers = shallowRef<readonly Summary[]>([]);
    // The id/token pair the last Connect click minted; cleared on close so a stale command can't be copied.
    const pairId = ref<string | undefined>(undefined);
    const pairToken = ref<string | undefined>(undefined);
    const minting = ref(false);
    const error = ref<string | undefined>(undefined);

    const refresh = async (): Promise<void> => {
        try {
            const response = await sandboxRequest(`/system/${door.slug}`);
            if (!response.ok) {
                return;
            }
            peers.value = ((await response.json()) as Record<string, Summary[] | undefined>)[door.listKey] ?? [];
        } catch {
            // Sandbox not reachable: leave the last known state rather than blanking the card.
        }
    };

    // Owner-only server-side; a member's click comes back 403 and says so rather than silently doing nothing.
    const connect = async (id: string): Promise<void> => {
        minting.value = true;
        error.value = undefined;
        try {
            const response = await sandboxRequest(`/system/${door.slug}/pair?id=${encodeURIComponent(id)}`, { method: `POST` });
            if (!response.ok) {
                error.value = response.status === 403 ? `Only the sandbox's owner can connect a ${door.noun}.` : `Couldn't start the connection (${response.status}).`;
                return;
            }
            pairToken.value = ((await response.json()) as { token: string }).token;
            pairId.value = id;
        } finally {
            minting.value = false;
        }
    };

    let unsubscribe: (() => void) | undefined;
    // One read on open for the state as it already stands, then nothing at all until something moves.
    const start = (): void => {
        void refresh();
        unsubscribe ??= onRuntimeChanged([door.domain], () => void refresh());
    };
    const stop = (): void => {
        unsubscribe?.();
        unsubscribe = undefined;
    };

    const close = (): void => {
        pairToken.value = undefined;
        pairId.value = undefined;
        error.value = undefined;
    };

    // Drops the peer's key and cuts its socket; the capability itself stays, so Connect can be offered again
    // as a fresh pairing, not a resume.
    const revoke = async (id: string): Promise<void> => {
        await sandboxRequest(`/system/${door.slug}/${encodeURIComponent(id)}`, { method: `DELETE` });
        await refresh();
    };

    const peerFor = (id: string): Summary | undefined => peers.value.find((peer) => peer.id === id);

    return { peers, peerFor, pairId, pairToken, minting, error, connect, revoke, refresh, start, stop, close };
}

export const HOST_DOOR: PeerDoor = { slug: `hosts`, domain: `hosts`, listKey: `hosts`, noun: `device` };
export const WEBEXT_DOOR: PeerDoor = { slug: `webext`, domain: `webext`, listKey: `browsers`, noun: `browser` };
