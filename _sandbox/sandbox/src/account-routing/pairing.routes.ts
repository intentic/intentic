import { PairingMintSchema, RouteSecretSchema } from "@intentic/sandbox-contract/schemas/account-routes";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { readBoundedJson } from "../http/bounded-body.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { filePairingsStore, type PairingsStore } from "./pairings-store.js";
import { type RouteSecretsStore, routeSecretsOf } from "./route-secrets.js";

/* THE PAIRING DOORS (2026-11-24, docs/architecture/account-routing.md), each for a person signed in, never an agent or a
 * machine credential (raw-routes.ts declares them so). The person's own editor, signed in to both sandboxes, makes a
 * pairing: it mints the secret at the target (`POST /account/pairings` there), then hands it to the asking sandbox
 * (`POST /account/routes/secret` here). Everyone mints, lists and revokes their own; a maintainer, who runs the sandbox's
 * people, also lists and revokes anyone's. */

const BODY_MAX = 4096;

export interface PairingRouteDeps {
    readonly pairings: PairingsStore;
    readonly secrets: RouteSecretsStore;
    readonly now?: () => number;
}

type AccountContext = Context<AppEnv>;

// The signed-in person, or the refusal for a request nobody signed in made.
const personOf = (c: AccountContext): { readonly email: string; readonly runsPeople: boolean; readonly guest: boolean } | Response => {
    const identity = c.get("identity");
    if (identity === undefined || identity.email === "") {
        return c.json({ error: "a pairing is a person's own: sign in to make or read one" }, 403);
    }
    return { email: identity.email.toLowerCase(), runsPeople: tierAtLeast(identity.tier, "maintainer"), guest: identity.tier === "guest" };
};

export const createPairingRoutes = (deps: PairingRouteDeps) => {
    const now = deps.now ?? Date.now;
    return {
        // The receiving side: the signed-in person lets the asking sandbox `from` route here as them.
        mint: async (c: AccountContext): Promise<Response> => {
            const person = personOf(c);
            if (person instanceof Response) {
                return person;
            }
            // A guest reaches nothing a pairing would open (member-reach.ts scopeRefusal reads a report and a read alone).
            if (person.guest) {
                return c.json({ error: "a guest member cannot pair another sandbox with themselves here" }, 403);
            }
            const read = await readBoundedJson(c.req.raw, BODY_MAX);
            const parsed = read.kind === "ok" ? PairingMintSchema.safeParse(read.value) : undefined;
            if (parsed?.success !== true) {
                return c.json({ error: "a pairing names the asking sandbox: {from: its tunnel id, fromName}" }, 400);
            }
            const minted = await deps.pairings.mint({ ...parsed.data, person: person.email }, now());
            return c.json({ from: parsed.data.from, person: person.email, ...minted });
        },
        list: async (c: AccountContext): Promise<Response> => {
            const person = personOf(c);
            if (person instanceof Response) {
                return person;
            }
            return c.json({ pairings: await deps.pairings.list(person.runsPeople ? undefined : person.email) });
        },
        // `?person=` names whose pairing a maintainer revokes; anyone else revokes their own.
        revoke: async (c: AccountContext): Promise<Response> => {
            const person = personOf(c);
            if (person instanceof Response) {
                return person;
            }
            const named = c.req.query("person")?.trim().toLowerCase() ?? "";
            const whose = named === "" ? person.email : named;
            if (whose !== person.email && !person.runsPeople) {
                return c.json({ error: "only a maintainer revokes another person's pairing" }, 403);
            }
            const removed = await deps.pairings.revoke(c.req.param("from") ?? "", whose);
            return removed ? c.json({ ok: true as const }) : c.json({ error: "no such pairing" }, 404);
        },
        // The asking side: the same person, signed in here, keeps the secret they minted at `target`.
        keep: async (c: AccountContext): Promise<Response> => {
            const person = personOf(c);
            if (person instanceof Response) {
                return person;
            }
            const read = await readBoundedJson(c.req.raw, BODY_MAX);
            const parsed = read.kind === "ok" ? RouteSecretSchema.safeParse(read.value) : undefined;
            if (parsed?.success !== true) {
                return c.json({ error: "a route secret names its target and the secret: {target: its tunnel id, secret}" }, 400);
            }
            await deps.secrets.put(parsed.data.target, person.email, parsed.data.secret, now());
            return c.json({ ok: true as const });
        },
        held: async (c: AccountContext): Promise<Response> => c.json({ routes: await deps.secrets.list() }),
    };
};

export const pairingRawRoutes = defineRawRoutes((services: Services) => {
    const routes = createPairingRoutes({ pairings: filePairingsStore(services.config.historyRoot), secrets: routeSecretsOf(services) });
    return {
        "POST /account/pairings": routes.mint,
        "GET /account/pairings": routes.list,
        "DELETE /account/pairings/{from}": routes.revoke,
        "POST /account/routes/secret": routes.keep,
        "GET /account/routes": routes.held,
    };
});
