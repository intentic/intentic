import { ref, shallowRef } from "vue";
import { onRuntimeChanged } from "../live/runtimeEvents";
import { sandboxRequest } from "../client/sandboxClient";

/* Drives "Connect this <peer>" on a peer capability's card: a device (host-kind) or a browser (webext-kind).
 * The daemon's peer doors are one shape (its peers/ directory), and so is the browser's side of them.
 *
 * Connect mints a single-use pairing token BOUND TO THIS CAPABILITY, so what it produces — a one-liner for a
 * machine, a code for an extension — can only ever connect the peer the user is looking at. The peer coming
 * online is the thing the user is standing there waiting for and it happens out-of-band, so the daemon PUSHES
 * it: the moment their socket lands, the door's domain frame arrives and this card re-reads itself, without a
 * refresh and without a timer. What stood here was a three-second timer, which meant a machine that came up
 * promptly still looked absent for up to three seconds, on the one screen whose entire content is whether it
 * came up.
 *
 * The token is shown once and never stored: a re-click mints a fresh one, which is cheaper than keeping a live
 * credential in a browser tab for ten minutes. What the dialog builds FROM the token (the command, the code)
 * is the dialog's own, since that is the one thing the two doors genuinely differ in. */
export interface PeerDoor {
    // The path segment the daemon serves the door under: /system/<slug>, /system/<slug>/pair, /system/<slug>/:id.
    readonly slug: "hosts" | "webext";
    // The runtime-change domain the daemon announces the door's liveness on.
    readonly domain: "hosts" | "webext";
    // The key the roster answers under.
    readonly listKey: "hosts" | "browsers";
    readonly noun: string;
}

export function usePeerConnect<Summary extends { readonly id: string; readonly online: boolean }>(door: PeerDoor) {
    // Shallow: a roster is replaced whole on every read, never edited in place, and a deep ref would unwrap the
    // generic summary type into something the dialogs cannot name.
    const peers = shallowRef<readonly Summary[]>([]);
    // The capability id the last Connect click minted for, and its token, the pair the dialog builds from.
    // Cleared when the dialog closes, so a stale command can never be copied from a reopened card.
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

    // Revoke: the peer's key is dropped and its socket cut. The capability stays, so the card can offer Connect
    // again; reconnecting is a fresh pairing, not a recovered one.
    const revoke = async (id: string): Promise<void> => {
        await sandboxRequest(`/system/${door.slug}/${encodeURIComponent(id)}`, { method: `DELETE` });
        await refresh();
    };

    const peerFor = (id: string): Summary | undefined => peers.value.find((peer) => peer.id === id);

    return { peers, peerFor, pairId, pairToken, minting, error, connect, revoke, refresh, start, stop, close };
}

export const HOST_DOOR: PeerDoor = { slug: `hosts`, domain: `hosts`, listKey: `hosts`, noun: `device` };
export const WEBEXT_DOOR: PeerDoor = { slug: `webext`, domain: `webext`, listKey: `browsers`, noun: `browser` };
