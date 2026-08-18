import type { ClaimChallenge, CreatorState, MembershipState, SandboxSummary, User } from "@intentic-app/api-contract";
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
    setupCodeClaimedAt: null,
    // Null for the same reason `setupCodeClaimedAt` is: the demo's sandbox is already up, so no wizard run
    // ever reported on it.
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    token: `demo-connect-token`,
    role: `owner`,
    providedTunnel: false,
    // The demo's sandbox is a local one — not something the cloud lane provisioned, and not one the
    // platform hosts.
    cloud: null,
    hosted: null,
};

// A platform that sells a membership, to an account that holds one — the state in which every creator surface
// is reachable, which is the only reason the demo answers this at all.
const DEMO_MEMBERSHIP: MembershipState = {
    enabled: true,
    member: true,
    status: `active`,
    renewsAt: `2026-09-01T00:00:00.000Z`,
    priceUsd: 20,
    creatorShare: 0.7,
    dailyCredits: 500,
    donationCredits: 100,
    credits: { allowance: 500, used: 140, remaining: 360, resetsAt: `2026-08-19T00:00:00.000Z` },
};

/* THE CREATOR CARD'S STATE. One name proved and one month closed, so the card shows what earning looks like;
 * payouts unconnected, because "you have not started" is the state the card most has to render well. */
const DEMO_CREATOR_STATE: CreatorState = {
    enabled: true,
    claims: [{ publisher: `acme`, repo: `acme/shop-web`, claimedAt: `2026-07-02T09:00:00.000Z` }],
    payouts: { connected: false, payoutsEnabled: false, detailsSubmitted: false },
    statements: [
        { month: `2026-07`, publisher: `acme`, amountCents: 12_840, payableAt: `2026-08-15T00:00:00.000Z`, expiresAt: `2027-07-31T00:00:00.000Z` },
    ],
    payments: [],
};

/* The challenge for a SECOND name. Two repositories back it and only the first is open in this workspace,
 * which is what puts the one-press path and the paste-a-line fallback both within reach on one screen. */
const DEMO_CLAIM_CHALLENGE: ClaimChallenge = {
    publisher: `acme`,
    repos: [`acme/shop-api`, `acme/shop-web`],
    path: `.intentic-claim`,
    token: `intentic-claim-6fe6b1d3b3bc1f8f815013ba948654d6`,
    claimedByYou: false,
    claimedByOther: false,
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
        // The pool's on/off answer, which is also what decides whether Settings shows Membership, Getting paid
        // and Offer a service at all — three tabs the demo simply did not have until this route existed.
        case `/rpc/pool/membership`:
            return json(DEMO_MEMBERSHIP);
        case `/rpc/invite/list`:
            return json({ invites: [] });
        case `/rpc/me`:
            return json(DEMO_USER);
        /* GETTING PAID — the creator card in Settings, which 404'd here until the claim step grew enough to be
         * worth showing. One name already proved, one still to prove, and no payout account: the state a
         * creator is actually in the first time this matters to them. */
        case `/rpc/creator/status`:
            return json(DEMO_CREATOR_STATE);
        // Names the demo workspace's own repositories publish under — what the claim step offers instead of an
        // empty box. `acme` only: the fixture's other repo is under a publisher nobody here can claim.
        case `/rpc/creator/claim/claimable`:
            return json({ names: [{ publisher: `acme`, repos: [`acme/shop-web`] }] });
        case `/rpc/creator/claim/challenge`:
            return json(DEMO_CLAIM_CHALLENGE);
        /* A claim can never verify here: nothing was pushed anywhere, and the refusal says so in the platform's
         * own words — which is exactly what the screen renders under the button.
         *
         * Shaped as oRPC's error JSON, not a bare `{message}`. The client only reads a refusal's sentence off
         * the five-key form (`defined`/`code`/`status`/`message`/`data`); anything else falls back to the
         * status's generic name, and the demo would show "Forbidden" where the product shows the reason. */
        case `/rpc/creator/claim`:
            return json(
                {
                    defined: false,
                    code: `FORBIDDEN`,
                    status: 403,
                    message: `Read all 2 repositories listed under acme — no .intentic-claim on the default branch yet. A push that landed on another branch does not count: the file has to be on the branch GitHub shows first.`,
                    data: {},
                },
                403,
            );
        default:
            console.info(`[demo] no fixture route for the platform's ${request.method} ${path}`);
            return json({ message: `The demo doesn't serve ${path}.` }, 404);
    }
};
