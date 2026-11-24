import { join } from "node:path";
import type { RouteHeld } from "@intentic/sandbox-contract/schemas/account-routes";
import { z } from "zod";
import { authRootOf } from "../state-paths.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

/* THE PAIRING SECRETS THIS SANDBOX HOLDS FOR ITSELF (2026-11-24, docs/architecture/account-routing.md): what each person
 * minted at another sandbox so this one may route there as them, sent beside the pass on every scope but a report
 * (ROUTE_SECRET_HEADER). Beside the capability vault in the auth root (mode 0600), outside the file routes, the tree walk
 * and the search index, and written only through `POST /account/routes/secret` by that same person signed in here: an
 * agent never reads one, so a turn cannot carry it anywhere the daemon does not send it. */

const RouteSecretRowSchema = z.object({
    // The target's tunnel id.
    target: z.string(),
    // Lower-cased.
    person: z.string(),
    secret: z.string(),
    createdAt: z.number(),
});

export const routeSecretsDocument = defineDocument({
    root: "auth",
    path: "route-secrets.json",
    schema: z.object({ routes: z.array(RouteSecretRowSchema) }),
});

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface RouteSecretsStore {
    readonly put: (target: string, person: string, secret: string, now: number) => Promise<void>;
    // The secret for (target, person), or undefined while that person has not allowed it.
    readonly secretFor: (target: string, person: string) => Promise<string | undefined>;
    // What is held, never a secret.
    readonly list: () => Promise<RouteHeld[]>;
    readonly remove: (target: string, person: string) => Promise<void>;
}

export const fileRouteSecrets = (path: string): RouteSecretsStore => {
    const file = openDocument(routeSecretsDocument, path, {
        fallback: () => ({ routes: [] }),
        mode: 0o600,
        // A credential nothing can regrow: a fresh file over an unreadable one would drop every pairing.
        onUnreadable: "refuse",
        atRestPurpose: routeSecretsDocument.path,
    });
    const matches = (target: string, person: string) => (row: { readonly target: string; readonly person: string }) => row.target === target && same(row.person, person);
    return {
        put: async (target, person, secret, now) => {
            const row = { target, person: person.toLowerCase(), secret, createdAt: now };
            await file.update((current) => ({ routes: [...current.routes.filter((held) => !matches(target, person)(held)), row] }));
        },
        secretFor: async (target, person) => (await file.read()).routes.find(matches(target, person))?.secret,
        list: async () => (await file.read()).routes.map(({ secret: _secret, ...held }) => held),
        remove: async (target, person) => {
            await file.update((current) => {
                const kept = current.routes.filter((row) => !matches(target, person)(row));
                return kept.length === current.routes.length ? current : { routes: kept };
            });
        },
    };
};

/** This daemon's store, in its auth root. */
export const routeSecretsOf = (services: { readonly config: { readonly agentAuthDir: string }; readonly workspace: { readonly root: string } }): RouteSecretsStore =>
    fileRouteSecrets(join(authRootOf({ agentAuthDir: services.config.agentAuthDir, workspaceRoot: services.workspace.root }), routeSecretsDocument.path));
