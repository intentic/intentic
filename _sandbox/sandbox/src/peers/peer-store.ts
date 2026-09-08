import type { z } from "zod";
import { enrollments, pairings } from "../store/enrollment.js";
import type { PeerStoreSpec } from "./peer.js";

// Credential half of a peer door: enrolled once, then a durable per-peer token on every reconnect; binds a pairing to
// one id so a redeemed token can only become the peer meant. Lives on /history, not /work (which the agent reads and
// writes all day), holding digests rather than tokens, and survives a container rebuild.

// What a pairing carries: which id it enrolls, and whatever this door records beside the digest.
type Pairing<Extra> = { readonly id: string } & Extra;

export interface PeerStore<Extra> {
    // Binds a pairing to one id, single-use and expiring; the token is shown once, to a browser or a provisioner.
    readonly mintPairing: (id: string, extra?: Extra) => { token: string; expiresIn: number };
    // Arms a setup-time token from the container env so a fresh install can self-enroll; false once already spent.
    readonly seedPairing: (id: string, token: string, extra?: Extra) => Promise<boolean>;
    // Redeems a pairing into a durable token, spent either way; undefined means unknown, expired, or replayed.
    readonly enroll: (pairToken: string) => Promise<({ readonly id: string; readonly token: string } & Extra) | undefined>;
    // Which peer is presenting this token, if any; the only authorization on the WebSocket.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    readonly list: () => Promise<Pairing<Extra>[]>;
    // Moves an enrollment onto a new id, keeping the peer's key valid; no re-pairing needed at the far end.
    readonly rename: (from: string, to: string) => Promise<void>;
    // Drop a peer's enrollment; its next connect is refused and its live socket is closed by the caller.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const filePeerStore = <Shape extends z.ZodRawShape>(
    historyRoot: string,
    spec: PeerStoreSpec<Shape>,
): PeerStore<z.infer<z.ZodObject<Shape>>> => {
    type Extra = z.infer<z.ZodObject<Shape>>;
    const files = spec.files(historyRoot);
    const pending = pairings<Pairing<Extra>>(files.consumed);
    const records = enrollments({ path: files.enrollments, key: spec.key, prefix: spec.prefix, extra: spec.extra });
    const replayable = spec.replayable === true;

    return {
        mintPairing: (id, extra) => pending.mint({ ...(extra as Extra), id }, { replayable }),
        seedPairing: (id, token, extra) => pending.arm(token, { ...(extra as Extra), id }),
        enroll: async (pairToken) => {
            const pairing = await pending.redeem(pairToken);
            if (pairing === undefined) {
                return undefined;
            }
            const { id, ...extra } = pairing;
            const token = await records.issue(id, extra as Extra);
            return { ...(extra as Extra), id, token };
        },
        verify: records.verify,
        enrolled: records.enrolled,
        list: records.list,
        rename: records.rename,
        revoke: records.revoke,
    };
};
