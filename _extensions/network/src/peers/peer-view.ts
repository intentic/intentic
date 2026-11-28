import { sandboxVouchOf, verifyAttestations, verifyExtensionPayload } from "@intentic/sandbox-contract/s2s";
import { z } from "zod";
import { parseCheckpointBody } from "../log/checkpoint.js";
import { CATALOG_PURPOSE, EXTENSION_ID } from "../log/entry.js";
import { keysFor } from "../log/verify.js";
import type { DiscoverHitView, PeerView } from "../wire.js";
import { DOOR_PREFIX, type PeerNet } from "./net.js";
import type { Peer } from "./peer-store.js";

/* WHAT A READER SEES OF A FOLLOWED SANDBOX: how far its identity is backed (L0 a key; L1 an own domain its TXT record
   confirmed; L2 the share of its entries a person approved with a passkey; L3 a vouch from an issuer this reader trusts,
   checked with the contract's verifyAttestation), how complete what was read is (the checkpoint's size against the
   entries verified here, and how many of the reader's witnesses cosigned that checkpoint), and why it is held when it is.
   It says who stands behind the words, never whether the words are true. */

const lines = (text: string): string[] => text.split(/[\s,]+/u).map((word) => word.trim()).filter((word) => word !== ``);

export const peerViewOf = (peer: Peer, opts: { readonly now: number; readonly trustedIssuers: string; readonly witnesses: string; readonly verified: number }): PeerView => {
    const attestations = verifyAttestations(peer.document, { now: opts.now, trustedIssuers: lines(opts.trustedIssuers) });
    const vouches = attestations.flatMap((checked) => {
        const vouch = sandboxVouchOf(checked.attestation);
        return checked.check.ok && vouch !== undefined ? [{ issuer: vouch.issuer.name ?? vouch.issuer.address, trusted: checked.check.trusted, claims: Object.fromEntries(Object.entries(vouch.claims).map(([key, value]) => [key, String(value)])) }] : [];
    });
    const declared = peer.checkpoint === null ? 0 : (parseCheckpointBody(peer.checkpoint.body)?.size ?? 0);
    return {
        sourceId: peer.sourceId,
        address: peer.address,
        name: peer.document.name,
        fingerprint: peer.document.fingerprint,
        state: peer.state,
        problem: peer.problem,
        domainVerified: peer.document.domains.includes(peer.address),
        passkeyShare: peer.size === 0 ? 0 : peer.cosigned / peer.size,
        vouches,
        level: vouches.some((vouch) => vouch.trusted) ? 3 : peer.cosigned > 0 ? 2 : peer.document.domains.includes(peer.address) ? 1 : 0,
        declared,
        verified: opts.verified,
        witnessed: peer.witnessed.filter((witness) => witness.size === declared).length,
        witnesses: lines(opts.witnesses).length,
        hasEvidence: peer.evidence !== null,
        syncedAt: peer.syncedAt,
    };
};

const GuideAnswerSchema = z.object({ results: z.array(z.object({ address: z.string(), signed: z.json() })) });
// The catalog as signed (verified over exactly these bytes), and the fields a hit shows, read from it after.
const SignedCatalogSchema = z.object({ catalog: z.record(z.string(), z.json()), sig: z.object({ ed25519: z.string(), mldsa65: z.string() }), fingerprint: z.string() });
const CatalogFieldsSchema = z.object({ name: z.string(), dataset: z.array(z.object({ about: z.string(), size: z.number() })).default([]), keywords: z.array(z.string()).default([]), inLanguage: z.array(z.string()).default([]) });

export type DiscoverHit = DiscoverHitView;

type GuideResult = z.infer<typeof GuideAnswerSchema>[`results`][number];

// One result, kept only when its catalog verifies against the identity found at the catalog's own address.
const verifiedHit = async (net: PeerNet, result: GuideResult, via: string): Promise<DiscoverHit | undefined> => {
    const catalog = SignedCatalogSchema.safeParse(result.signed);
    if (!catalog.success) {
        return undefined;
    }
    const source = await net.resolve(result.address);
    const keys = source.ok ? keysFor(source.document, catalog.data.fingerprint) : undefined;
    if (keys === undefined || !verifyExtensionPayload(EXTENSION_ID, CATALOG_PURPOSE, catalog.data.catalog, catalog.data.sig, keys)) {
        return undefined;
    }
    const fields = CatalogFieldsSchema.safeParse(catalog.data.catalog);
    if (!fields.success) {
        return undefined;
    }
    const { name, dataset, keywords, inLanguage } = fields.data;
    return { address: result.address, name, types: dataset.map((entry) => entry.about), keywords, languages: inLanguage, via };
};

const guideResults = async (net: PeerNet, guide: string, params: URLSearchParams, signal: AbortSignal): Promise<GuideResult[]> => {
    const resolved = await net.resolve(guide);
    // allow(silent-catch): a guide that does not answer adds nothing to this search
    const answer = resolved.ok ? await net.get(resolved.host, `${DOOR_PREFIX}/guide/search?${params}`, signal).catch(() => undefined) : undefined;
    const parsed = GuideAnswerSchema.safeParse(answer?.body);
    return parsed.success ? parsed.data.results.slice(0, 50) : [];
};

// Each configured guide asked; every catalog it answers is checked against the identity found at the catalog's own
// address, so a guide can leave a source out but cannot put words in its mouth.
export const discover = async (net: PeerNet, guides: string, query: { readonly type?: string | undefined; readonly keyword?: string | undefined }, signal: AbortSignal): Promise<DiscoverHit[]> => {
    const params = new URLSearchParams();
    if (query.type !== undefined) {
        params.set(`type`, query.type);
    }
    if (query.keyword !== undefined) {
        params.set(`keyword`, query.keyword);
    }
    const hits = new Map<string, DiscoverHit>();
    for (const guide of lines(guides).slice(0, 8)) {
        for (const result of await guideResults(net, guide, params, signal)) {
            const hit = hits.has(result.address) ? undefined : await verifiedHit(net, result, guide);
            if (hit !== undefined) {
                hits.set(hit.address, hit);
            }
        }
    }
    return [...hits.values()];
};
