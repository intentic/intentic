import type { Context } from "hono";
import type { z } from "zod";
import { enrollments, pairings, type Presented } from "./enrollment.js";
import type { PeerStoreSpec } from "./peer.js";

// The bearer doors' half of the rule the socket is held to (peer-routes.ts): a token nobody holds is the caller's
// problem, a manifest this daemon could not read is its own. They differ in who has to act, which is why answering
// the second as the first sends a peer off to re-pair a credential that was never withdrawn.
export const refusePresented = (c: Context, refused: Exclude<Presented, { readonly kind: "enrolled" }>): Response =>
    refused.kind === "unreadable"
        ? c.json({ error: `this sandbox cannot read its enrollment manifest right now (${refused.detail})` }, 503)
        : c.json({ error: "unauthorized" }, 401);

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
    // Which peer is presenting this token — and when none does, whether that is settled or just this read's silence;
    // the only authorization on the WebSocket.
    readonly verify: (presented: string) => Promise<Presented>;
    readonly enrolled: (id: string) => Promise<boolean>;
    // Every enrollment, with the card each is a connection of.
    readonly list: () => Promise<(Pairing<Extra> & { readonly card: string })[]>;
    // The card a pairing for `id` would be a connection of: what the pair route checks the grant by before minting.
    readonly cardFor: (id: string) => string;
    // A card's enrollments onto its new name, and dropping them all: one write each (Enrollments says why).
    readonly relabelCard: (from: string, to: string) => Promise<readonly { readonly from: string; readonly to: string }[]>;
    readonly revokeCard: (card: string) => Promise<readonly string[]>;
    readonly amend: (id: string, patch: Partial<Extra>) => Promise<void>;
    // Drop a peer's enrollment; its next connect is refused and its live socket is closed by the caller.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const filePeerStore = <Shape extends z.ZodRawShape>(
    historyRoot: string,
    spec: PeerStoreSpec<Shape>,
): PeerStore<z.infer<z.ZodObject<Shape>>> => {
    type Extra = z.infer<z.ZodObject<Shape>>;
    const files = spec.files(historyRoot);
    const pending = pairings<Pairing<Extra>>(files.consumed, spec.pairTtlMs);
    const records = enrollments({ path: files.enrollments, key: spec.key, prefix: spec.prefix, extra: spec.extra, card: spec.card });
    const replayable = spec.replayable === true;
    // What a pairing for `id` records beside it: the door's own card rule, under whatever a caller passed explicitly.
    const pairingExtra = (id: string, extra: Extra | undefined): Extra => ({ ...spec.card?.pairing(id), ...extra }) as Extra;

    return {
        mintPairing: (id, extra) => pending.mint({ ...pairingExtra(id, extra), id }, { replayable }),
        seedPairing: (id, token, extra) => pending.arm(token, { ...pairingExtra(id, extra), id }),
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
        cardFor: (id) => (spec.card === undefined ? id : spec.card.of({ id, ...spec.card.pairing(id) })),
        relabelCard: records.relabelCard,
        revokeCard: records.revokeCard,
        amend: records.amend,
        revoke: records.revoke,
    };
};
