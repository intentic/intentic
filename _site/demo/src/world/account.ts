import type { HostedPlanState, SandboxSummary, TrashedSandbox, User } from "@intentic/api-contract";
import { FREE_TIER, hostedTier } from "@intentic/constants";
import { DESK_SANDBOX_NAME } from "../fixture/desk";
import { homeSandboxLogos } from "../fixture/home/logos";
import { HOME_SANDBOXES } from "../fixture/home/sandboxes";
import { deskEdition, demoTier, homeRecording, noSandboxes } from "../mode";
import { outageHosted, outageReport } from "../outage";
import { DEMO_DAEMON_ORIGIN } from "../transport";

// THE DEMO ACCOUNT AS IT STANDS WHEN THE PAGE LOADS: who is signed in, the sandboxes they hold, what they deleted
// lately and the plan they are on. world/sandboxRegistry.ts starts from these and keeps what the visitor changes after.

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

export const DEMO_SANDBOXES: readonly SandboxSummary[] = noSandboxes
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
export const DEMO_HOSTED_PLAN: HostedPlanState = {
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

const DAY_MS = 86_400_000;

// Both lanes, a name deleted twice and a row on its last day, so the account's Recently deleted page shows each thing it
// has to tell apart: what a restore brings back, which of two boxes of one name is which, and what goes tomorrow.
export const DEMO_TRASH: readonly TrashedSandbox[] = [
    {
        id: `trash-staging`,
        name: `acme-staging`,
        image: null,
        deletedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
        purgeAfter: new Date(Date.now() + 5 * DAY_MS).toISOString(),
        hosted: true,
    },
    {
        id: `trash-scratch-new`,
        name: `scratch`,
        image: null,
        deletedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        purgeAfter: new Date(Date.now() + 7 * DAY_MS - 3 * 3_600_000).toISOString(),
        hosted: false,
    },
    {
        id: `trash-scratch-old`,
        name: `scratch`,
        image: null,
        deletedAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
        purgeAfter: new Date(Date.now() + 4 * DAY_MS).toISOString(),
        hosted: false,
    },
    {
        id: `trash-laptop`,
        name: `ada-laptop`,
        image: null,
        deletedAt: new Date(Date.now() - 6 * DAY_MS).toISOString(),
        purgeAfter: new Date(Date.now() + 1 * DAY_MS).toISOString(),
        hosted: false,
    },
];
