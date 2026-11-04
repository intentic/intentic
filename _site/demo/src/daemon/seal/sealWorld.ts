import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { Seal, SealHouse, SealMode, SealOpen, SealPerson, SealVia, SealView } from "@intentic/sandbox-contract/schemas/seal";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { API_MAIN_FIXER_ID, CONFLICT_AGENT_ID, HELD_AGENT_ID, LATENCY_AGENT_ID, REVIEW_AGENT_ID, WEB_MAIN_FIXER_ID } from "../../fixture/fleet";
import { demoMode, demoTier } from "../../mode";
import { DEMO_SANDBOX, DEMO_USER } from "../../platform";

// PRIVATE CONVERSATIONS AS THE DEMO'S DAEMON KEEPS THEM (sandbox-contract schemas/seal.ts; the daemon's auth/seal-scope.ts):
// each conversation's seal, the house rule, and every summary framed for the one person the demo is: Ada, at the tier
// `?as=` reads her as. A seal she is not on cuts her card down to whose it is, where it stands and its diff, as the daemon
// cuts it; one she reads carries the whole seal and how she reads it. Served in the full fleet only (`?mode=full` and
// `busy`), where every state a surface distinguishes is there to look at; every other mode is as it always was.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ADA: SealPerson = { email: DEMO_USER.email, name: DEMO_USER.name };
const GRACE: SealPerson = { email: `grace@acme.dev`, name: `Grace Hopper` };
const JO: SealPerson = { email: `jo@acme.dev`, name: `Jo Park` };
const MAX: SealPerson = { email: `max@acme.dev`, name: `Max Weber` };

const sealedFleet = demoMode.id === `full` || demoMode.id === `busy`;

// `?seal=locked` serves the house as an organisation fixed it, `?seal=two` with its two-person rule; kept per tab.
const HOUSE_KEY = `intentic.demo.sealHouse`;
const houseAsked = (): string | null => {
    const asked = new URL(window.location.href).searchParams.get(`seal`);
    if (asked !== null) {
        window.sessionStorage.setItem(HOUSE_KEY, asked);
    }
    return window.sessionStorage.getItem(HOUSE_KEY);
};
const houseFlag = houseAsked();

// The house as this daemon holds it: the rule, the reader's own default, and the two facts an organisation decides.
interface DemoHouse {
    mode: SealMode;
    ownDefault?: boolean;
    readonly locked: boolean;
    readonly twoPerson: boolean;
}
const house: DemoHouse = {
    mode: houseFlag === `locked` ? `private` : `chooses`,
    locked: houseFlag === `locked`,
    twoPerson: houseFlag === `two`,
};

const opening = (open: Omit<SealOpen, "id">, id: string): SealOpen => ({ id, ...open });

// The fixtures: one card of each kind the board, the gate, the chat's head and its strips tell apart.
const seeded = (now: number): [string, Seal][] => [
    // Grace's fix of the web main line, running: sealed from Ada, who as the owner may open it without asking.
    [WEB_MAIN_FIXER_ID, { since: now - 2 * HOUR, readers: [GRACE] }],
    // Jo's work, ready to land: sealed from Ada, who already asked Jo to show it to her.
    [REVIEW_AGENT_ID, { since: now - 5 * HOUR, readers: [JO], asks: [{ ...ADA, at: now - 40 * 60_000 }] }],
    // Ada's own private conversation with Grace, which Max asked to read and which was opened once without asking.
    [
        HELD_AGENT_ID,
        {
            since: now - 3 * DAY,
            readers: [ADA, GRACE],
            asks: [{ ...MAX, at: now - 12 * 60_000 }],
            opens: [
                opening(
                    { ...MAX, at: now - 3 * HOUR, until: now + 21 * HOUR, reason: `The support dashboard is down for every customer and this chat holds the only notes on the card that broke it.`, approvedBy: { ...GRACE, at: now - 3 * HOUR + 4 * 60_000 } },
                    `open-held-1`,
                ),
                opening({ ...MAX, at: now - 2 * DAY, until: now - DAY, reason: `Checking whether this touched the billing export before the audit.`, refusedBy: { ...GRACE, at: now - 2 * DAY + 600_000 } }, `open-held-0`),
            ],
        },
    ],
    // Grace's conversation that Ada asked to open without asking, waiting on a second person with Full access.
    [API_MAIN_FIXER_ID, { since: now - DAY, readers: [GRACE], opens: [opening({ ...ADA, at: now - 25 * 60_000, until: now + DAY, reason: `The API main line is red and Grace is on a plane; I need to see what the fix agent already tried.`, pending: true }, `open-api-1`)] }],
    // Grace's refused land, which Max asked to open without asking: Ada is someone who could be the second person.
    [CONFLICT_AGENT_ID, { since: now - DAY, readers: [GRACE], opens: [opening({ ...MAX, at: now - 50 * 60_000, until: now + DAY, reason: `This conflicts with the auth release going out tonight and I need to see which side of it is right.`, pending: true }, `open-auth-1`)] }],
    // Grace's latency investigation, which she showed Ada for a day: Ada reads it, read-only.
    [LATENCY_AGENT_ID, { since: now - 6 * HOUR, readers: [GRACE], grants: [{ ...ADA, until: now + 20 * HOUR, by: GRACE.email }] }],
];

export const seals = new Map<string, Seal>(sealedFleet ? seeded(Date.now()) : []);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** How Ada reads a sealed conversation now, or undefined when she may not (the daemon's readVia). */
const readVia = (seal: Seal, now: number): { readonly via: SealVia; readonly until?: number } | undefined => {
    if (seal.readers.some((reader) => same(reader.email, ADA.email))) {
        return { via: `reader` };
    }
    const grant = seal.grants?.find((held) => same(held.email, ADA.email) && held.until > now);
    if (grant !== undefined) {
        return { via: `grant`, until: grant.until };
    }
    const open = seal.opens?.find((held) => same(held.email, ADA.email) && held.pending !== true && held.refusedBy === undefined && held.until > now);
    return open === undefined ? undefined : { via: `open`, until: open.until };
};

export const sealOf = (id: string): Seal | undefined => seals.get(id);
const viaOf = (id: string): { readonly via: SealVia; readonly until?: number } | undefined => {
    const seal = seals.get(id);
    return seal === undefined ? undefined : readVia(seal, Date.now());
};
/** Whether Ada cannot read this conversation's words at all. */
export const sealedFromCaller = (id: string): boolean => seals.has(id) && viaOf(id) === undefined;
/** Whether Ada may read but not write in it: shown it for a day, or opened it without asking. */
export const readOnlyForCaller = (id: string): boolean => {
    const via = viaOf(id)?.via;
    return via === `grant` || via === `open`;
};
/** Whether Ada is one of its readers, who may change it and answer who asks. */
export const holdsSeal = (id: string): boolean => viaOf(id)?.via === `reader`;

const pendingOf = (seal: Seal): SealOpen | undefined => seal.opens?.find((open) => open.pending === true && open.refusedBy === undefined);

// The fields a sealed card keeps (the daemon's SEALED_KEEPS): everything else is its words, or describes them.
const SEALED_KEEPS = [
    `id`, `status`, `provider`, `harness`, `runner`, `updatedAt`, `answeredAt`, `startedAt`, `archivedAt`, `branch`, `branches`, `base`, `owner`,
    `startedBy`, `areas`, `home`, `fresh`, `forkedFrom`, `autoLand`, `landRequested`, `diff`, `landedPresence`, `conflictCauses`, `awaitingWake`,
] as const satisfies readonly (keyof AgentSummary)[];

const sealedCard = (agent: AgentSummary, seal: Seal): AgentSummary => {
    const pending = pendingOf(seal);
    const opener = pending !== undefined && same(pending.email, ADA.email);
    const approver = pending !== undefined && !opener && roleAtLeast(demoTier, `maintainer`);
    const view: SealView = { sealed: true, readers: seal.readers.slice(0, 1) };
    if (seal.asks?.some((ask) => same(ask.email, ADA.email)) === true) {
        view.asked = true;
    }
    if (pending !== undefined && (opener || approver)) {
        view.pending = pending;
    }
    if (demoTier === `owner` && pending === undefined) {
        view.canOpen = true;
    }
    if (approver) {
        view.canApprove = true;
    }
    const kept = Object.fromEntries(SEALED_KEEPS.filter((field) => agent[field] !== undefined).map((field) => [field, agent[field]]));
    const attention = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: agent.attention.conflict, need: false };
    return { ...kept, id: agent.id, status: agent.status, provider: agent.provider, harness: agent.harness, updatedAt: agent.updatedAt, attention, seal: view };
};

/** One summary as Ada is shown it: as it is, with the whole seal and how she reads it, or cut to a sealed card. */
export const framedForCaller = (agent: AgentSummary): AgentSummary => {
    const seal = seals.get(agent.id);
    if (seal === undefined) {
        return agent;
    }
    const via = readVia(seal, Date.now());
    if (via === undefined) {
        return sealedCard(agent, seal);
    }
    const view: SealView = { readers: seal.readers, via: via.via };
    if (via.until !== undefined) {
        view.until = via.until;
    }
    for (const key of [`grants`, `asks`, `opens`] as const) {
        const list = seal[key];
        if (list !== undefined && list.length > 0) {
            Object.assign(view, { [key]: list });
        }
    }
    const pending = pendingOf(seal);
    if (pending !== undefined && !same(pending.email, ADA.email) && roleAtLeast(demoTier, `maintainer`)) {
        view.canApprove = true;
    }
    return { ...agent, seal: view };
};

/** The house rule as Ada reads it (GET /seal). */
export const houseNow = (): SealHouse => {
    const answer: SealHouse = {
        mode: house.mode,
        locked: house.locked,
        twoPerson: house.twoPerson,
        hosted: DEMO_SANDBOX.hosted !== null,
        sealed: seals.size,
        startsPrivate: house.mode === `private` || (house.mode === `chooses` && house.ownDefault === true),
    };
    if (house.ownDefault !== undefined) {
        answer.ownDefault = house.ownDefault;
    }
    return answer;
};
export const setHouseMode = (mode: SealMode): void => {
    house.mode = mode;
};
export const setOwnDefault = (on: boolean): void => {
    house.ownDefault = on;
};
export const houseLocked = (): boolean => house.locked;
export const houseTwoPerson = (): boolean => house.twoPerson;
export const caller = (): SealPerson => ADA;
export const OPEN_FOR_MS = DAY;

/** A conversation Ada starts, private as she pressed it or as the house starts hers. */
export const startSealed = (id: string, asked: boolean | undefined): void => {
    if (seals.has(id) || house.mode === `everyone` || !(asked ?? houseNow().startsPrivate)) {
        return;
    }
    seals.set(id, { since: Date.now(), readers: [ADA] });
};
