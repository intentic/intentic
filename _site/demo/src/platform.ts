import { apiContract, type HostedPlanState, type SandboxSummary, type TrashedSandbox, type User } from "@intentic/api-contract";
import { FREE_TIER, hostedTier } from "@intentic/constants";
import { inviteRecords } from "./fixture/access";
import { DESK_SANDBOX_NAME } from "./fixture/desk";
import { deskEdition, demoTier } from "./mode";
import { demoOutage, outageHosted, outageReport } from "./outage";
import { DEMO_DAEMON_ORIGIN, json } from "./transport";

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

// The rung the demo account's machine is on; the Billing page reads its shape off the machine, not the account.
const DEMO_MACHINE_TIER = hostedTier(`standard`);

// Account on the hosted plan, which is why Settings shows the Billing tab at all.
const DEMO_HOSTED_PLAN: HostedPlanState = {
    enabled: true,
    onPlan: true,
    status: `active`,
    renewsAt: `2026-10-01T00:00:00.000Z`,
    priceUsd: 20,
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
                hours: { kind: `slot`, usedMinutes: 12_720, allowanceMinutes: DEMO_MACHINE_TIER.monthlyHours * 60, resetsAt: `2026-10-01T00:00:00.000Z` },
                // A machine that has not been killed for memory; the page shows nothing at 0, which is the point.
                oomsThisWeek: 0,
            },
        ],
        // The account's free hours, untouched: its one machine spends its slot's month instead.
        freeHours: { kind: `free`, usedMinutes: 0, allowanceMinutes: FREE_TIER.monthlyHours * 60, resetsAt: `2026-10-01T00:00:00.000Z` },
        freeTier: { id: FREE_TIER.id, shape: FREE_TIER, monthlyHours: FREE_TIER.monthlyHours },
    },
};

// One of each lane, so Sandbox ▸ Recently deleted shows both sentences a restore can promise.
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
    sandbox: {
        list: () => ({ sandboxes: [DEMO_SANDBOX] }),
        trash: () => ({ sandboxes: [...DEMO_TRASH] }),
        // The recovery panel's command carries one; nothing ever claims it here.
        fixCode: () => ({ code: `DEMOFIX7K2Q`, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
        hostedStatus: () => ({ machine: demoOutage === `hosted` ? `failed` : `started` }),
        wake: () => ({ ok: true }),
        hostedRestart: () => ({ ok: true }),
    },
    // Plan's on/off answer decides whether Settings shows the Billing tab.
    hostedPlan: { state: () => DEMO_HOSTED_PLAN },
    me: { get: () => DEMO_USER },
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
type RouteTables = Readonly<Record<string, Readonly<Record<string, { readonly "~orpc": { readonly route: { readonly path?: string } } } | undefined>> | undefined>>;
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
    const path = url.pathname;

    if (path.startsWith(`/api/auth/`)) {
        // Only get-session matters; others must not 404 or better-auth reads it as signed-out.
        return json(path.endsWith(`/get-session`) ? SESSION : { ok: true });
    }

    const answer = ROUTED.get(path);
    if (answer !== undefined) {
        return answer();
    }
    console.info(`[demo] no fixture route for the platform's ${request.method} ${path}`);
    return json({ message: `The demo doesn't serve ${path}.` }, 404);
};
