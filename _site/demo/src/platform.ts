import type { HostedPlanState, SandboxSummary, User } from "@intentic/api-contract";
import { inviteRecords } from "./fixture/access";
import { DESK_SANDBOX_NAME } from "./fixture/desk";
import { deskEdition, demoTier } from "./mode";
import { DEMO_DAEMON_ORIGIN, json } from "./transport";

// Fetch handler for the three router gates before the workspace renders:
// GET /api/auth/get-session — session probe
// GET /rpc/sandbox/list — zero sandboxes bounces to /setup
// GET /rpc/billing/plan — the account badge, read lazily
// `daemonUrl` points the sandbox client at the demo daemon's origin.

export const DEMO_USER: User = { id: `demo-user`, email: `ada@acme.dev`, name: `Ada Lovelace`, image: null };

export const DEMO_SANDBOX: SandboxSummary = {
    id: `demo`,
    name: deskEdition ? DESK_SANDBOX_NAME : `acme-shop`,
    image: null,
    daemonUrl: DEMO_DAEMON_ORIGIN,
    lastSeenAt: new Date().toISOString(),
    setupCodeClaimedAt: null,
    // Null: sandbox is already up, so no setup wizard run ever reported on it.
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    // Null: nothing has ever removed this sandbox's container, so there is no removal to report.
    removedAt: null,
    removedBy: null,
    token: `demo-connect-token`,
    role: demoTier,
    providedAddress: false,
    // Null: no real container or CA-signed cert to offer a loopback shortcut from.
    localHostname: null,
    // Local sandbox, not a machine the platform hosts.
    hosted: null,
};

// Account on the hosted plan, which is why Settings shows the Billing tab at all.
const DEMO_HOSTED_PLAN: HostedPlanState = {
    enabled: true,
    onPlan: true,
    status: `active`,
    renewsAt: `2026-10-01T00:00:00.000Z`,
    priceUsd: 20,
    hosted: {
        slots: 1,
        machines: [{ sandboxId: DEMO_SANDBOX.id, name: DEMO_SANDBOX.name, region: `arn`, wokeAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }],
        usage: { month: new Date().toISOString().slice(0, 7), usedMinutes: 12_720, allowanceMinutes: null, resetsAt: `2026-10-01T00:00:00.000Z` },
        shape: { cpus: 4, memoryMb: 4096, volumeGb: 10 },
    },
};

const SESSION = {
    session: { id: `demo-session`, userId: DEMO_USER.id, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString() },
    user: DEMO_USER,
};

// The accept link a demo invite hands back, pointing at the demo's own copy of that page.
const INVITE_LINK = `${window.location.origin}${import.meta.env.BASE_URL}invite/demo-token`;

// The platform's half of the Access tab. Its shape is the contract's (`members`, never `invites`), and its writes
// are the mirror the real ones are: the tier and the cards were already pushed to the daemon by the owner's browser
// before any of these is called, so each answers with the roster rather than writing it again.
// A demo platform can't send mail, which is the `local-link` an owner is handed instead.
const invite = (path: string): Response | undefined => {
    switch (path) {
        case `/rpc/invite/list`:
        // `setRole` answers at /invite/role, and `create`/`resend` add the link to the same roster.
        case `/rpc/invite/role`:
        case `/rpc/invite/revoke`:
            return json({ members: inviteRecords() });
        case `/rpc/invite/create`:
        case `/rpc/invite/resend`:
            return json({ members: inviteRecords(), link: INVITE_LINK, delivery: `local-link` });
        // What the standalone accept page (/demo/invite/:token) reads; a demo link is always the one still pending.
        case `/rpc/invite/preview`:
            return json({ status: `pending`, sandboxName: DEMO_SANDBOX.name, invitedEmail: `rin@acme.dev`, role: `viewer` });
        default:
            return undefined;
    }
};

export const platform = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname;

    if (path.startsWith(`/api/auth/`)) {
        // Only get-session matters; others must not 404 or better-auth reads it as signed-out.
        return json(path.endsWith(`/get-session`) ? SESSION : { ok: true });
    }

    const invited = invite(path);
    if (invited !== undefined) {
        return invited;
    }

    switch (path) {
        case `/rpc/sandbox/list`:
            return json({ sandboxes: [DEMO_SANDBOX] });
        case `/rpc/billing/plan`:
            return json({ plan: `pro`, entitlements: { sandboxes: 5, members: 10 } });
        // Plan's on/off answer decides whether Settings shows the Billing tab.
        case `/rpc/hosted-plan`:
            return json(DEMO_HOSTED_PLAN);
        case `/rpc/me`:
            return json(DEMO_USER);
        default:
            console.info(`[demo] no fixture route for the platform's ${request.method} ${path}`);
            return json({ message: `The demo doesn't serve ${path}.` }, 404);
    }
};
