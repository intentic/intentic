import type { SandboxSummary, User } from "@intentic-app/api-contract";
import { DEMO_DAEMON_ORIGIN, json } from "./transport";

/* THE PLATFORM, as a fetch handler — the small half. The app asks it three things before the workspace can
 * render, and they are exactly the three router gates:
 *
 *   GET /api/auth/get-session  → requireAuth: better-auth's session probe (not oRPC — its own client).
 *   GET /rpc/sandbox/list      → requireSetup: zero sandboxes would bounce the shell to /setup.
 *   GET /rpc/billing/plan      → the account badge, read lazily when the account panel opens.
 *
 * The sandbox row is what points the whole daemon half at the fixture: `daemonUrl` is the demo daemon's origin,
 * so sandboxClient, sandboxRpc and the terminal socket all address it without knowing anything has changed. */

export const DEMO_USER: User = { id: `demo-user`, email: `ada@acme.dev`, name: `Ada Lovelace`, image: null };

export const DEMO_SANDBOX: SandboxSummary = {
    id: `demo`,
    name: `acme-shop`,
    image: null,
    daemonUrl: DEMO_DAEMON_ORIGIN,
    lastSeenAt: new Date().toISOString(),
    token: `demo-connect-token`,
    role: `owner`,
    providedTunnel: false,
};

const SESSION = {
    session: { id: `demo-session`, userId: DEMO_USER.id, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString() },
    user: DEMO_USER,
};

export const platform = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname;

    if (path.startsWith(`/api/auth/`)) {
        // get-session is the only one the demo ever needs; sign-out and the rest are inert but must not 404
        // (better-auth surfaces a failed call as a thrown error, which the router guard would read as
        // signed-out and bounce to /login).
        return json(path.endsWith(`/get-session`) ? SESSION : { ok: true });
    }

    switch (path) {
        case `/rpc/sandbox/list`:
            return json({ sandboxes: [DEMO_SANDBOX] });
        case `/rpc/billing/plan`:
            return json({ plan: `pro`, entitlements: { sandboxes: 5, members: 10 } });
        case `/rpc/invite/list`:
            return json({ invites: [] });
        case `/rpc/me`:
            return json(DEMO_USER);
        default:
            console.info(`[demo] no fixture route for the platform's ${request.method} ${path}`);
            return json({ message: `The demo doesn't serve ${path}.` }, 404);
    }
};
