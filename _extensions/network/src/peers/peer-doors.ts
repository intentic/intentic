import type { PublicRouteHandler, SandboxIdentity } from "@intentic/extension-api";
import { z } from "zod";
import type { Checkpoint } from "../log/checkpoint.js";
import type { ServedEntry } from "../log/entry.js";
import { ENTRIES_PAGE_MAX } from "../server/door.js";
import type { Peer, PeerStore } from "./peer-store.js";
import { cosignFor, type WitnessAnswer, type WitnessDeps, WitnessRequestSchema } from "./witness.js";

/* THE DOORS THIS SANDBOX OPENS FOR OTHERS' LOGS, each off until the owner turns its mode on:
   - `witness/cosign` (POST): cosign a log's checkpoint (witness.ts).
   - `mirror/<fingerprint tail>/log/checkpoint|log/entries|identity` (GET): a verified copy of a followed log, the same
     shapes its origin serves, so a reader syncs from here while the origin sleeps and still verifies against the
     origin's own keys. Only logs in good standing are mirrored, and only what was verified.
   - `guide/search?type=&keyword=&lang=` (GET): the signed catalogs of followed logs that match, so a reader finds
     sources by the kind of data they hold. */

export interface PeerDoorDeps {
    readonly peers: PeerStore;
    readonly witness: WitnessDeps;
    readonly mirror: () => Promise<boolean>;
    readonly guide: () => Promise<boolean>;
}

type GuideHit = { readonly address: string; readonly signed: z.core.util.JSONType };
type PeerDoorAnswer = Checkpoint | SandboxIdentity | WitnessAnswer | { readonly error: string } | { readonly size: number; readonly entries: readonly ServedEntry[] } | { readonly results: readonly GuideHit[] };

const json = (body: PeerDoorAnswer, status = 200): Response => Response.json(body, { status, headers: { "access-control-allow-origin": `*`, "cache-control": status === 200 ? `public, max-age=30` : `no-store` } });

const NOT_HERE = (): Response => json({ error: `this sandbox does not serve that` }, 404);

// A mirrored log's identity or checkpoint, exactly as verified; nothing while it has not published.
const mirrorOf = (peer: Peer, what: string): Response => {
    if (what === `identity`) {
        return json(peer.document);
    }
    return peer.checkpoint === null ? NOT_HERE() : json(peer.checkpoint);
};

const CatalogFieldsSchema = z.object({
    catalog: z.object({ dataset: z.array(z.object({ about: z.string() })).default([]), keywords: z.array(z.string()).default([]), inLanguage: z.array(z.string()).default([]) }),
});

// Whether a followed log's verified catalog matches what was asked; an absent criterion matches anything.
const matches = (catalog: string, type: string | null, keyword: string | null, lang: string | null): boolean => {
    const parsed = CatalogFieldsSchema.safeParse(JSON.parse(catalog));
    if (!parsed.success) {
        return false;
    }
    const { dataset, keywords, inLanguage } = parsed.data.catalog;
    const typeOk = type === null || dataset.some((entry) => entry.about === type);
    const keywordOk = keyword === null || keywords.some((word) => word.toLowerCase().includes(keyword.toLowerCase()));
    return typeOk && keywordOk && (lang === null || inLanguage.includes(lang));
};

export const peerDoorOf = (deps: PeerDoorDeps): PublicRouteHandler => {
    const witness = async (request: Request): Promise<Response> => {
        // allow(silent-catch): a body that is not JSON is no request, which the schema refuses
        const body = WitnessRequestSchema.safeParse(await request.json().catch(() => undefined));
        if (!body.success) {
            return json({ error: `a cosign request is { address, checkpoint }` }, 400);
        }
        const outcome = await cosignFor(deps.witness, body.data);
        return outcome.ok ? json(outcome.answer) : json({ error: outcome.error }, outcome.status);
    };
    const mirror = async (request: Request, tail: string, what: string): Promise<Response> => {
        const peer = (await deps.mirror()) ? deps.peers.byFingerprintTail(tail) : undefined;
        if (peer === undefined || peer.state !== `ok`) {
            return NOT_HERE();
        }
        if (what !== `log/entries`) {
            return mirrorOf(peer, what);
        }
        const params = new URL(request.url).searchParams;
        const start = Number(params.get(`start`) ?? `0`);
        const end = Math.min(Number(params.get(`end`) ?? `0`), peer.size, start + ENTRIES_PAGE_MAX);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
            return json({ error: `ask for entries start <= i < end within ${peer.size}` }, 400);
        }
        return json({ size: peer.size, entries: deps.peers.served(peer.sourceId, start, end) });
    };
    const guide = async (request: Request): Promise<Response> => {
        if (!(await deps.guide())) {
            return NOT_HERE();
        }
        const params = new URL(request.url).searchParams;
        const results = deps.peers
            .peers()
            .filter((peer) => peer.state === `ok` && peer.catalog !== null && matches(peer.catalog, params.get(`type`), params.get(`keyword`), params.get(`lang`)))
            .slice(0, 50)
            .map((peer) => ({ address: peer.address, signed: JSON.parse(peer.catalog ?? `null`) }));
        return json({ results });
    };
    return async (request) => {
        const path = new URL(request.url).pathname.replace(/^\/+/u, ``);
        if (path === `witness/cosign`) {
            return request.method === `POST` ? witness(request) : undefined;
        }
        const mirrored = /^mirror\/([a-z2-7]{52})\/(log\/checkpoint|log\/entries|identity)$/u.exec(path);
        if (mirrored !== null && request.method === `GET`) {
            return mirror(request, mirrored[1] ?? ``, mirrored[2] ?? ``);
        }
        return path === `guide/search` && request.method === `GET` ? guide(request) : undefined;
    };
};
