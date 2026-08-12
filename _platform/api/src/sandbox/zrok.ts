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

const call = async (args: { endpoint: string; token: string; method: string; path: string; body?: unknown }): Promise<unknown> => {
    const response = await fetch(`${args.endpoint}/api/v2${args.path}`, {
        method: args.method,
        headers: { "x-token": args.token, ...(args.body === undefined ? {} : { "content-type": `application/json` }) },
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
 * and the reconcile key retention diffs against rows — derived from the sandbox's 12-hex id so the hub's
 * account list reads as the sandbox list. The password is random and immediately discarded: nothing ever logs
 * in with it (the account TOKEN is the credential that matters), and password reset is an admin op. */
export const accountEmail = (sandboxId: string, zone: string): string => `sandbox-${sandboxId}@${zone}`;

export const createSandboxAccount = async (
    config: { apiEndpoint: string; adminToken: string; zone: string },
    args: { sandboxId: string; password: string },
): Promise<{ accountToken: string }> => {
    const created = accountCreatedSchema.parse(
        await call({
            endpoint: config.apiEndpoint,
            token: config.adminToken,
            method: `POST`,
            path: `/account`,
            body: { email: accountEmail(args.sandboxId, config.zone), password: args.password },
        }),
    );
    return { accountToken: created.accountToken };
};

// Revoke a sandbox's reachability outright: the account goes, and every environment, share and name under it
// goes with it. Idempotent for the delete flow and the reconcile: an account already gone is a success.
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

/* THE RECONCILE the daily sweep runs (retention.ts): every account this platform minted whose sandbox row is
 * gone, deleted. The hub's account list is the outer truth and the DB is the inner one; `live` carries the
 * 12-hex ids of the rows that exist, and the synthetic email shape (`sandbox-<id>@<zone>`) is what makes an
 * account recognizably ours — anything else on the hub belongs to somebody else and is never touched.
 *
 * Simpler than the tunnel reaper it replaces, deliberately: there is no idleness heuristic left, because a
 * sandbox being offline says nothing (a sleeping hosted machine is disconnected by design) and a grant costs
 * one row rather than ten DNS records against a quota. */
const accountListSchema = z.array(z.object({ email: z.string() }));
export const reconcileZrokAccounts = async (
    config: { apiEndpoint: string; adminToken: string; zone: string },
    args: { live: Set<string>; dryRun: boolean; log: (email: string) => void; onError: (email: string, error: unknown) => void },
): Promise<{ scanned: number; orphaned: number; deleted: number; failed: number }> => {
    const accounts = accountListSchema.parse(await call({ endpoint: config.apiEndpoint, token: config.adminToken, method: `GET`, path: `/accounts` }));
    const ours = new RegExp(`^sandbox-([0-9a-f]{12})@${config.zone.replaceAll(`.`, `\\.`)}$`);
    const orphaned = accounts.filter((account) => {
        const match = ours.exec(account.email);
        return match !== null && !args.live.has(match[1] ?? ``);
    });
    let deleted = 0;
    let failed = 0;
    for (const account of orphaned) {
        args.log(account.email);
        if (args.dryRun) {
            continue;
        }
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequenced deletes keep the hub comfortable
            await call({ endpoint: config.apiEndpoint, token: config.adminToken, method: `DELETE`, path: `/account`, body: { email: account.email } });
            deleted += 1;
        } catch (error) {
            failed += 1;
            args.onError(account.email, error);
        }
    }
    return { scanned: accounts.length, orphaned: orphaned.length, deleted, failed };
};
