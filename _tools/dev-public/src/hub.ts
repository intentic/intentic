/* THE DEV PLATFORM'S OWN HUB CLIENT — the same three admin calls the platform makes when it grants a sandbox
 * reachability (_platform/api/src/sandbox/zrok.ts), made here on behalf of the dev platform itself. Deliberately
 * re-stated rather than imported: the platform's client is welded to its Config and its error taxonomy, and the
 * house rule both follow — plain fetch against the v2 spec, no SDK — makes this copy a page that changes only
 * when the hub's API does. The fake hub (@intentic/fake-zrok) answers all three, which is what the tests run
 * against. */

export interface HubConfig {
    // The controller API as this machine reaches it (ZROK_API_ENDPOINT).
    readonly endpoint: string;
    // The hub's admin token (ZROK_ADMIN_TOKEN) — the credential that mints and revokes accounts.
    readonly adminToken: string;
}

/* The hub's own media type, not `application/json`: zrok's v2 API declares `application/zrok.v1+json` on every
 * operation, and go-swagger answers a body sent as plain JSON with `500 no consumer registered for
 * application/json` — a server error for what is really a header mismatch. */
const MEDIA_TYPE = `application/zrok.v1+json`;

const call = async (config: HubConfig, method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${config.endpoint}/api/v2${path}`, {
        method,
        headers: { "x-token": config.adminToken, accept: MEDIA_TYPE, ...(body === undefined ? {} : { "content-type": MEDIA_TYPE }) },
        body: body === undefined ? null : JSON.stringify(body),
        // A stalled hub must reject (with the endpoint named) rather than hang the tool forever.
        signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401) {
        throw new Error(`the zrok hub rejected the admin token (HTTP 401) — check ZROK_ADMIN_TOKEN / ZROK_API_ENDPOINT in the root .env`);
    }
    if (!response.ok) {
        const detail = (await response.text().catch(() => ``)).slice(0, 300);
        throw new Error(`zrok ${method} ${path} failed (HTTP ${response.status})${detail === `` ? `` : `: ${detail}`}`);
    }
    const text = await response.text();
    return text === `` ? undefined : (JSON.parse(text) as unknown);
};

// Revoke the grant outright: the account goes, and the environment, shares and names under it go with it.
// Idempotent: an account already gone (404) is a success, so `--reset` cannot fail on a half-torn-down state.
export const deleteAccount = async (config: HubConfig, email: string): Promise<void> => {
    try {
        await call(config, `DELETE`, `/account`, { email });
    } catch (error) {
        if (error instanceof Error && /HTTP 404/.test(error.message)) {
            return;
        }
        throw error;
    }
};

/* One grant = one hub account, exactly as the platform mints one per sandbox. The hub answers a DUPLICATE email
 * with a bare 500 and offers no way to read an existing account's token back (v2 has create and delete, and
 * nothing else), so a collision — a previous mint whose token file never landed — is recovered through a delete
 * and one retry. The email is derived from this machine's own seed, so the recovery can never reach anybody
 * else's account. */
export const mintAccount = async (config: HubConfig, args: { email: string; password: string }): Promise<{ accountToken: string }> => {
    const create = async (): Promise<{ accountToken: string }> => {
        const result = (await call(config, `POST`, `/account`, args)) as { accountToken?: unknown };
        if (typeof result?.accountToken !== `string` || result.accountToken === ``) {
            throw new Error(`the zrok hub answered the account mint without an accountToken`);
        }
        return { accountToken: result.accountToken };
    };
    try {
        return await create();
    } catch (error) {
        await deleteAccount(config, args.email).catch(() => {});
        try {
            return await create();
        } catch {
            throw error;
        }
    }
};

// The public namespace the wildcard frontend serves — what `zrok2 create name` claims labels under. Mirrors the
// platform's resolution: the namespace named `public`, else whichever the hub lists first.
export const publicNamespaceToken = async (config: HubConfig): Promise<string> => {
    const namespaces = (await call(config, `GET`, `/namespaces`)) as { namespaceToken?: unknown; name?: unknown }[];
    const open = namespaces.find((namespace) => namespace.name === `public`) ?? namespaces[0];
    if (open === undefined || typeof open.namespaceToken !== `string`) {
        throw new Error(`the zrok hub reports no namespaces — its bootstrap did not complete`);
    }
    return open.namespaceToken;
};
