import type { IdentityReach, IdentitySigned, PublicRouteHandler, SandboxIdentity } from "@intentic/extension-api";
import { z } from "zod";
import { CATALOG_PURPOSE, EXTENSION_ID, LOG_PROTOCOL } from "../log/entry.js";
import { type Checkpoint, originOf } from "../log/checkpoint.js";
import type { ServedEntry } from "../log/entry.js";
import { toBase64 } from "../log/merkle.js";
import type { LogStore } from "./log-store.js";

/* THE LOG'S PUBLIC DOORS (`contributes.publicRoutes`, served at /door/intentic.network/<path> to anyone): the latest
   signed checkpoint, a page of entries, inclusion and consistency proofs, the signed catalog of what the log holds, and
   the sandbox's identity document. Everything a reader needs to verify the log without trusting this host: the keys are
   in the identity document, which the reader pins at the sandbox's own address. Reads only; nothing here changes the log. */

export const ENTRIES_PAGE_MAX = 200;

// The catalog as served: the record, and the sandbox's signature over it.
export interface SignedCatalog {
    readonly catalog: Catalog;
    readonly sig: IdentitySigned[`sig`];
    readonly fingerprint: string;
}
// A schema.org DataCatalog: who keeps the log, where it is, and how many records of each type it holds. A type alias,
// not an interface, so it reads as the JSON `api.identity.sign` takes.
type Catalog = {
    "@context": `https://schema.org`;
    "@type": `DataCatalog`;
    name: string;
    identifier: string;
    url: string;
    additionalType: string;
    publisher: { "@type": `Organization`; name: string; identifier: string };
    isPartOf: string;
    dataset: { "@type": `Dataset`; about: string; size: number }[];
    keywords: string[];
    inLanguage: string[];
    dateModified: string;
    size: number;
};

// Everything a door answers.
type DoorAnswer =
    | Checkpoint
    | SandboxIdentity
    | SignedCatalog
    | { readonly error: string }
    | { readonly size: number; readonly entries: readonly ServedEntry[] }
    | { readonly index: number; readonly size: number; readonly proof: readonly string[] }
    | { readonly from: number; readonly to: number; readonly proof: readonly string[] };

const json = (body: DoorAnswer, status = 200): Response =>
    Response.json(body, { status, headers: { "cache-control": status === 200 ? `public, max-age=30` : `no-store`, "access-control-allow-origin": `*` } });

const IntSchema = z.coerce.number().int().min(0);

const queryOf = (request: Request, ...names: readonly string[]): number[] | undefined => {
    const params = new URL(request.url).searchParams;
    const values = names.map((name) => IntSchema.safeParse(params.get(name) ?? undefined));
    return values.every((value) => value.success) ? values.map((value) => (value.success ? value.data : 0)) : undefined;
};

export interface DoorDeps {
    readonly logs: LogStore;
    readonly identity: IdentityReach;
    readonly keywords: () => Promise<readonly string[]>;
    readonly languages: () => Promise<readonly string[]>;
}

// The schema.org DataCatalog describing this log, signed as the sandbox; signed again only when the log grew.
const catalogOf = (deps: DoorDeps) => {
    let kept: { readonly size: number; readonly body: SignedCatalog } | undefined;
    return async (): Promise<SignedCatalog> => {
        const size = deps.logs.size();
        if (kept?.size === size) {
            return kept.body;
        }
        const document = await deps.identity.document();
        const catalog = {
            "@context": `https://schema.org`,
            "@type": `DataCatalog`,
            name: document.name,
            identifier: document.fingerprint,
            url: `https://${document.host}/door/${EXTENSION_ID}/catalog`,
            additionalType: LOG_PROTOCOL,
            publisher: { "@type": `Organization`, name: document.name, identifier: document.fingerprint },
            isPartOf: originOf(document.host),
            dataset: Object.entries(deps.logs.typeCounts()).map(([type, count]) => ({ "@type": `Dataset` as const, about: type, size: count })),
            keywords: [...(await deps.keywords())],
            inLanguage: [...(await deps.languages())],
            dateModified: new Date().toISOString(),
            size,
        } satisfies Catalog;
        const signed = await deps.identity.sign(CATALOG_PURPOSE, catalog);
        kept = { size, body: { catalog, sig: signed.sig, fingerprint: signed.fingerprint } };
        return kept.body;
    };
};

export const doorOf = (deps: DoorDeps): PublicRouteHandler => {
    const catalog = catalogOf(deps);
    const routes = new Map<string, (request: Request) => Promise<Response>>(
        Object.entries({
        "log/checkpoint": async () => {
            const checkpoint = deps.logs.checkpoint();
            return checkpoint === undefined ? json({ error: `this log has nothing published yet` }, 404) : json(checkpoint);
        },
        "log/entries": async (request) => {
            const [start = 0, end = 0] = queryOf(request, `start`, `end`) ?? [];
            const size = deps.logs.size();
            if (end <= start || start >= size) {
                return json({ error: `ask for entries start <= i < end within the log's ${size}` }, 400);
            }
            return json({ size, entries: deps.logs.served(start, Math.min(end, size, start + ENTRIES_PAGE_MAX)) });
        },
        "log/proof/inclusion": async (request) => {
            const [index = 0, size = 0] = queryOf(request, `index`, `size`) ?? [-1, -1];
            if (index >= size || size > deps.logs.size()) {
                return json({ error: `ask for index < size <= the log's size` }, 400);
            }
            return json({ index, size, proof: deps.logs.inclusion(index, size).map((hash) => toBase64(hash)) });
        },
        "log/proof/consistency": async (request) => {
            const [from = 0, to = 0] = queryOf(request, `from`, `to`) ?? [-1, -1];
            if (from > to || to > deps.logs.size() || from < 0) {
                return json({ error: `ask for from <= to <= the log's size` }, 400);
            }
            return json({ from, to, proof: deps.logs.consistency(from, to).map((hash) => toBase64(hash)) });
        },
        catalog: async () => json(await catalog()),
        identity: async () => json(await deps.identity.document()),
        }),
    );
    return async (request) => {
        if (request.method !== `GET`) {
            return undefined;
        }
        const route = routes.get(new URL(request.url).pathname.replace(/^\/+/u, ``));
        return route === undefined ? undefined : route(request);
    };
};
