import { apiContract, type HostedPlanState, type SandboxSummary, type TrashedSandbox, type User } from "@intentic/api-contract";
import { FREE_TIER, hostedTier } from "@intentic/constants";
import { inviteRecords } from "./fixture/access";
import { DESK_SANDBOX_NAME } from "./fixture/desk";
import { homeSandboxLogos } from "./fixture/home/logos";
import { HOME_SANDBOXES } from "./fixture/home/sandboxes";
import { officeOrganisation, officeOrganisations } from "./fixture/offices/organisation";
import { deskEdition, demoTier, homeRecording, noSandboxes, signedOut } from "./mode";
import { demoOutage, outageHosted, outageReport } from "./outage";
import { DEMO_DAEMON_ORIGIN, json } from "./transport";
import { ingressPath, type BrowsingCatalog } from "@intentic/api-contract/ingress";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { DEMO_CATALOGS } from "./daemon/accounts";

// Fetch handler for the platform's half of the gates before the workspace renders:
// GET /api/auth/get-session — session probe
// GET /rpc/sandbox/list — zero sandboxes bounces to /setup
// `daemonUrl` points the sandbox client at the demo daemon's origin. Every /rpc answer is keyed by the api contract's
// own procedure (PlatformAnswers), so one the contract drops fails the typecheck here rather than being answered forever.

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
    // The owner's alone, as the platform hands it out (sandbox.routes.ts `connectTokenFor`): null on a member's row, so
    // a surface that would print it for a member shows here the way it does for them.
    token: demoTier === `owner` ? `demo-connect-token` : null,
    role: demoTier,
    providedAddress: false,
    // Null: no real container or CA-signed cert to offer a loopback shortcut from.
    localHostname: null,
    // Local sandbox, not a machine the platform hosts, unless the outage acted out (outage.ts) is on one of ours.
    hosted: outageHosted(),
    // What the sandbox's own machine last reported, which only an outage gives it reason to (outage.ts).
    hostReport: outageReport(),
};

export const DEMO_SANDBOXES: SandboxSummary[] = noSandboxes
    ? []
    : homeRecording
    ? [
        { ...DEMO_SANDBOX, image: homeSandboxLogos.shop },
        // Each at its own daemon address, so the home conversation it opens on is its own (fixture/home/sandboxes.ts).
        { ...DEMO_SANDBOX, id: HOME_SANDBOXES.research.id, name: `Research`, image: homeSandboxLogos.research, daemonUrl: HOME_SANDBOXES.research.origin },
        { ...DEMO_SANDBOX, id: HOME_SANDBOXES.personal.id, name: `Personal`, image: homeSandboxLogos.personal, daemonUrl: HOME_SANDBOXES.personal.origin },
    ]
    : [DEMO_SANDBOX];

// The rung the demo account's machine is on; the Billing page reads its shape off the machine, not the account.
const DEMO_MACHINE_TIER = hostedTier(`standard`);

// Account on the hosted plan, which is why Settings shows the Billing tab at all.
const DEMO_HOSTED_PLAN: HostedPlanState = {
    enabled: true,
    onPlan: true,
    status: `active`,
    renewsAt: `2026-10-01T00:00:00.000Z`,
    priceUsd: 20,
    onSale: [`standard`, `max`],
    hosted: {
        slots: 2,
        // One free slot and one bought at the rung the demo machine stands on.
        slotsByTier: { [FREE_TIER.id]: 1, [DEMO_MACHINE_TIER.id]: 1 },
        machines: [
            {
                sandboxId: DEMO_SANDBOX.id,
                name: DEMO_SANDBOX.name,
                region: `arn`,
                wokeAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
                // A paying account in the demo, so the machine stands on a slot at its rung and spends that slot's own
                // month rather than the account's free hours.
                tier: DEMO_MACHINE_TIER.id,
                shape: DEMO_MACHINE_TIER,
                hours: {
                    kind: `slot`,
                    usedMinutes: 12_720,
                    allowanceMinutes: DEMO_MACHINE_TIER.monthlyHours * 60,
                    resetsAt: `2026-10-01T00:00:00.000Z`,
                },
                // A machine that has not been killed for memory; the page shows nothing at 0, which is the point.
                oomsThisWeek: 0,
            },
        ],
        // The account's free hours, untouched: its one machine spends its slot's month instead.
        freeHours: { kind: `free`, usedMinutes: 0, allowanceMinutes: FREE_TIER.monthlyHours * 60, resetsAt: `2026-10-01T00:00:00.000Z` },
        freeTier: { id: FREE_TIER.id, shape: FREE_TIER, monthlyHours: FREE_TIER.monthlyHours },
    },
};

// Both lanes, a name deleted twice and a row on its last day, so the account's Recently deleted page shows each thing it
// has to tell apart: what a restore brings back, which of two boxes of one name is which, and what goes tomorrow.
const DEMO_TRASH: readonly TrashedSandbox[] = [
    {
        id: `trash-staging`,
        name: `acme-staging`,
        image: null,
        deletedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        purgeAfter: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        hosted: true,
    },
    {
        id: `trash-scratch-new`,
        name: `scratch`,
        image: null,
        deletedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        purgeAfter: new Date(Date.now() + 7 * 86_400_000 - 3 * 3_600_000).toISOString(),
        hosted: false,
    },
    {
        id: `trash-scratch-old`,
        name: `scratch`,
        image: null,
        deletedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        purgeAfter: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        hosted: false,
    },
    {
        id: `trash-laptop`,
        name: `ada-laptop`,
        image: null,
        deletedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
        purgeAfter: new Date(Date.now() + 1 * 86_400_000).toISOString(),
        hosted: false,
    },
];

const SESSION = {
    session: { id: `demo-session`, userId: DEMO_USER.id, expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString() },
    user: DEMO_USER,
};

// The accept link a demo invite hands back, pointing at the demo's own copy of that page.
const INVITE_LINK = `${window.location.origin}${import.meta.env.BASE_URL}invite/demo-token`;

type Api = typeof apiContract;

// What a procedure answers, read off its output schema's Standard Schema types: the shape the editor's client expects.
type OutputOf<C> = C extends { readonly "~orpc": { readonly outputSchema?: infer S } }
    ? S extends { readonly "~standard": { readonly types?: infer T } }
        ? NonNullable<T> extends { readonly output: infer O }
            ? O
            : never
        : never
    : never;

// The procedures the demo stands in for, each held to its own output type.
type PlatformAnswers = { readonly [G in keyof Api]?: { readonly [P in keyof Api[G]]?: () => OutputOf<Api[G][P]> } };

// The platform's half of the Access tab. Its shape is the contract's (`members`, never `invites`), and its writes
// are the mirror the real ones are: the tier and the cards were already pushed to the daemon by the owner's browser
// before any of these is called, so each answers with the roster rather than writing it again.
// A demo platform can't send mail, which is the `local-link` an owner is handed instead.
const roster = () => ({ members: inviteRecords() });
const sent = () => ({ members: inviteRecords(), link: INVITE_LINK, delivery: `local-link` as const });

const ANSWERS: PlatformAnswers = {
    org: { list: () => officeOrganisations, get: () => officeOrganisation },
    sandbox: {
        list: () => ({ sandboxes: DEMO_SANDBOXES }),
        hostedOffer: () => ({
            enabled: true,
            startJourney: true,
            remaining: 1,
            hours: { allowance: FREE_TIER.monthlyHours, remaining: FREE_TIER.monthlyHours },
        }),
        // Addresses are minted, so the new sandbox's dialog offers the connected machines and the command for a server.
        addressOffer: () => ({ enabled: true }),
        trash: () => ({ sandboxes: [...DEMO_TRASH] }),
        // The recovery panel's command carries one; nothing ever claims it here.
        fixCode: () => ({ code: `DEMOFIX7K2Q`, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
        hostedStatus: () => ({ machine: demoOutage === `hosted` ? `failed` : `started` }),
        wake: () => ({ ok: true }),
        hostedRestart: () => ({ ok: true }),
    },
    // Plan's on/off answer decides whether Settings shows the Billing tab.
    hostedPlan: { state: () => DEMO_HOSTED_PLAN },
    // Both ways in, as the live platform offers them: the sign-in screens and the desktop app's dialog draw both.
    me: { get: () => (signedOut ? null : DEMO_USER), signInOptions: () => ({ google: true, email: true }) },
    invite: {
        list: roster,
        setRole: roster,
        revoke: roster,
        create: sent,
        resend: sent,
        // What the standalone accept page (/demo/invite/:token) reads; a demo link is always the one still pending.
        preview: () => ({ status: `pending`, sandboxName: DEMO_SANDBOX.name, invitedEmail: `rin@acme.dev`, role: `viewer` }),
    },
};

// A procedure's route path, read structurally as contract-serve reads the sandbox contract: `~orpc` is oRPC's own
// metadata, which the contract's types do not spell.
type RouteTables = Readonly<
    Record<string, Readonly<Record<string, { readonly "~orpc": { readonly route: { readonly path?: string } } } | undefined>> | undefined>
>;
// SAFETY: every group of apiContract is a record of oRPC procedures, each carrying its route under `~orpc`; a group or
// name the contract lacks reads as undefined.
const routeOf = (group: string, name: string): string | undefined => (apiContract as RouteTables)[group]?.[name]?.[`~orpc`].route.path;

// Each answer at the path the editor's OpenAPILink calls it by: `/rpc` and the procedure's own route. Every output the
// contract declares is an object, or null for no signed-in user.
const ROUTED = new Map<string, () => Response>(
    Object.entries(ANSWERS).flatMap(([group, procedures]) =>
        Object.entries(procedures ?? {}).flatMap(([name, answer]: [string, (() => object | null) | undefined]) => {
            const path = routeOf(group, name);
            return path === undefined || answer === undefined ? [] : [[`/rpc${path}`, () => json(answer())] as const];
        }),
    ),
);

export const platform = async (request: Request, url: URL): Promise<Response> => {
    if (url.pathname === ingressPath(`modelCatalog`)) {
        return json({ catalogs: NATIVE_PROVIDERS.flatMap((provider) => {
            const models = DEMO_CATALOGS[provider]?.models ?? [];
            return models.length === 0 ? [] : [{ provider, verifiedAt: Date.now(), models: models.map(({ id, label }) => ({ id, label })) }];
        }) } satisfies BrowsingCatalog);
    }
    const path = url.pathname;

    if (path.startsWith(`/api/auth/`)) {
        // Only get-session matters; others must not 404 or better-auth reads it as signed-out.
        return json(path.endsWith(`/get-session`) ? (signedOut ? null : SESSION) : { ok: true });
    }

    const answer = ROUTED.get(path);
    if (answer !== undefined) {
        return answer();
    }
    console.info(`[demo] no fixture route for the platform's ${request.method} ${path}`);
    return json({ message: `The demo doesn't serve ${path}.` }, 404);
};
