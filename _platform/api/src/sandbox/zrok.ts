import { z } from "zod";

/* THE SELF-HOSTED TUNNEL FABRIC — zrok v2 (the hub the `zrok` Komodo stack runs), replacing the Cloudflare
 * tunnel machinery this file's predecessor (cloudflare.ts) drove. The economics inverted with it: a sandbox
 * used to cost the zone a tunnel plus ~10 DNS records against a hard per-zone quota (error 81045); under the
 * hub ONE wildcard record and ONE wildcard certificate serve every sandbox, and "provisioning reachability"
 * shrinks to minting one zrok ACCOUNT per sandbox — a single fast API call, which is also why the
 * pre-provisioned pool died with the migration.
 *
 * The trust split it preserves: the platform holds the hub's ADMIN token and mints per-sandbox account
 * tokens, but the Ziti identity a sandbox actually tunnels with is born INSIDE the box (`zrok2 enable` runs
 * there) — the platform can create and revoke reachability, never impersonate it. Names under the wildcard
 * (`sandbox-<id>`, port slots, the public label, panels) are attached by the DAEMON with its own account
 * token; the platform's only naming job is deriving the hostname the browser already knows, exactly as
 * before (sandbox-contract's tunnel-ids — unchanged on purpose, so the announce flow, the wizard's address
 * line and every derived id survive the provider swap untouched).
 *
 * Plain fetch against the v2 spec (basePath /api/v2, auth header x-token) — the house rule cloudflare.ts and
 * hosted/fly.ts follow: no provider SDK. */

// The operator misconfigured the platform (bad admin token, wrong endpoint) — nothing a user can fix; routes
// surface it as a gateway failure. Named apart from refusals so retention can log them differently.
export class ZrokError extends Error {}

const accountCreatedSchema = z.object({ accountToken: z.string() });
const namespacesSchema = z.array(z.object({ namespaceToken: z.string(), name: z.string(), open: z.boolean().optional() }));

/* The hub's own media type, not `application/json`: zrok's v2 API declares `application/zrok.v1+json` on every
 * operation, and go-swagger answers a body sent as plain JSON with `500 no consumer registered for
 * application/json` — a server error for what is really a header mismatch, which is why it is spelled out
 * here rather than left to a default. */
const MEDIA_TYPE = `application/zrok.v1+json`;

const call = async (args: { endpoint: string; token: string; method: string; path: string; body?: unknown }): Promise<unknown> => {
    const response = await fetch(`${args.endpoint}/api/v2${args.path}`, {
        method: args.method,
        headers: { "x-token": args.token, accept: MEDIA_TYPE, ...(args.body === undefined ? {} : { "content-type": MEDIA_TYPE }) },
        body: args.body === undefined ? null : JSON.stringify(args.body),
        // A stalled hub must reject (surfacing upstream) rather than hang the caller forever.
        signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401) {
        throw new ZrokError(`the zrok hub rejected the platform's token (HTTP 401) — check ZROK_ADMIN_TOKEN / ZROK_API_ENDPOINT`);
    }
    if (!response.ok) {
        const detail = (await response.text().catch(() => ``)).slice(0, 300);
        throw new ZrokError(`zrok ${args.method} ${args.path} failed (HTTP ${response.status})${detail === `` ? `` : `: ${detail}`}`);
    }
    const text = await response.text();
    return text === `` ? undefined : (JSON.parse(text) as unknown);
};

/* One reachability grant = one zrok account. The synthetic email is the account's stable identity on the hub
 * derived from the sandbox's own 12-hex id, so the address, the account and the row all name the same thing.
 * The password is random and immediately discarded: nothing ever logs in with it (the account TOKEN is the
 * credential that matters), and password reset is an admin op. */
export const accountEmail = (sandboxId: string, zone: string): string => `sandbox-${sandboxId}@${zone}`;

export const createSandboxAccount = async (
    config: { apiEndpoint: string; adminToken: string; zone: string },
    args: { sandboxId: string; password: string },
): Promise<{ accountToken: string }> => {
    const create = async (): Promise<{ accountToken: string }> =>
        accountCreatedSchema.parse(
            await call({
                endpoint: config.apiEndpoint,
                token: config.adminToken,
                method: `POST`,
                path: `/account`,
                body: { email: accountEmail(args.sandboxId, config.zone), password: args.password },
            }),
        );
    try {
        return await create();
    } catch (error) {
        /* One retry, through a delete. The hub answers a DUPLICATE email with a bare 500 and offers no way to
         * read an existing account's token back (v2 has create and delete, and nothing else), so a collision
         * would otherwise strand this sandbox permanently — and a collision can only mean one thing: a
         * previous mint whose row-write never landed, i.e. an account of OURS that nothing holds. The email is
         * derived from this sandbox's own id, so this can never reach anybody else's account. */
        await deleteSandboxAccount(config, args.sandboxId).catch(() => {});
        try {
            return await create();
        } catch {
            throw error;
        }
    }
};

// Revoke a sandbox's reachability outright: the account goes, and every environment, share and name under it
// goes with it. Idempotent: an account already gone is a success, so a retried removal cannot fail on it.
export const deleteSandboxAccount = async (
    config: { apiEndpoint: string; adminToken: string; zone: string },
    sandboxId: string,
): Promise<void> => {
    try {
        await call({
            endpoint: config.apiEndpoint,
            token: config.adminToken,
            method: `DELETE`,
            path: `/account`,
            body: { email: accountEmail(sandboxId, config.zone) },
        });
    } catch (error) {
        if (error instanceof ZrokError && /HTTP 404/.test(error.message)) {
            return;
        }
        throw error;
    }
};

// The public namespace the wildcard frontend serves — resolved once at boot and cached by the caller: names
// the daemon attaches live under it, and the enable payload hands the token into the box so it can.
export const publicNamespaceToken = async (config: { apiEndpoint: string; adminToken: string }): Promise<string> => {
    const namespaces = namespacesSchema.parse(
        await call({ endpoint: config.apiEndpoint, token: config.adminToken, method: `GET`, path: `/namespaces` }),
    );
    const open = namespaces.find((namespace) => namespace.name === `public`) ?? namespaces[0];
    if (open === undefined) {
        throw new ZrokError(`the zrok hub reports no namespaces — its bootstrap did not complete`);
    }
    return open.namespaceToken;
};

/* WHY THERE IS NO DAILY RECONCILE (the tunnel reaper's opposite number): zrok v2 exposes account CREATE and
 * DELETE and nothing else — no listing, no lookup — so the hub cannot be asked what it holds and a forgotten
 * grant could never be found again. The invariant is kept at the only place it can be: a sandbox's grant is
 * revoked BEFORE its row is deleted (sandbox.routes.ts), so a hub hiccup fails the removal and leaves the row
 * — the record of the grant — instead of stranding an address nobody can revoke. The other way an orphan
 * appears (a mint whose row-write did not land) heals itself on the next mint, above. */
