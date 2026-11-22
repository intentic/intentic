import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { type AgentAccess, memberAccess } from "@intentic/sandbox-contract/schemas/members";
import { REACH_DEVICE_GRANTS, type ReachDevice, reachHostOf, type ReachLinkOut, type SandboxReach } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import { grants } from "../../fixture/access";
import { demoDevices } from "../../fixture/devices";
import { demoCapabilities } from "../../fixture/sandbox";
import { demoTier } from "../../mode";
import { DEMO_USER } from "../../platform";
import { DEMO_DAEMON_ORIGIN } from "../../transport";
import { LAPTOP_SANDBOX } from "../../world/sandboxRegistry";
import { demoRoles } from "../extensions/roles";
import { linksList } from "../machine/linkStore";

// WHAT EACH SANDBOX OF THE DEMO'S WORLD IS TIED TO (GET /system/reach), read off the same stores the other screens draw:
// the shop's cards (fixture/sandbox.ts), its computers (fixture/devices.ts), its inbound links (linkStore.ts) and its
// roster (fixture/access.ts), so the account's access map agrees with the Capabilities board, the Devices page and
// Access. The laptop is the owner's other sandbox and hands the shop work; any other address answers with no ties.

const reader = (): SandboxReach[`reader`] => ({ tier: demoTier, agents: demoTier !== `viewer` && demoTier !== `guest` });
const owner = demoTier === `owner` || demoTier === `maintainer`;
const managesPeople = owner;

// Everyone on the roster but the reader, and the owner when the reader is not them.
const othersHere = () => grants().filter((grant) => grant.email !== DEMO_USER.email);
const ownerBesides = demoTier === `owner` ? 0 : 1;

// The people besides the reader whose own agents may use one card: the owner when the reader is not them, and everyone on
// the roster who runs agents and whose reach holds the card.
const RUNS: ReadonlySet<AgentAccess> = new Set([`run`, `home`]);
const othersFor = (card: string): number | undefined => {
    if (!managesPeople) {
        return undefined;
    }
    const people = othersHere().filter((grant) => RUNS.has(memberAccess(grant).agents) && (grant.credentials === undefined || grant.credentials.capabilities.includes(card)));
    return people.length + ownerBesides;
};

// The reader's own conversations: the owner's reach every card, a member's what their row's reach names.
const yours = (card: string): boolean => {
    const row = grants().find((grant) => grant.email === DEMO_USER.email);
    return reader().agents && (row?.credentials === undefined || row.credentials.capabilities.includes(card));
};

const switchesOn = (config: CapabilitySummary[`config`]): string[] => REACH_DEVICE_GRANTS.filter((grant) => config[grant] === `on`);

const DEVICE_KINDS = { device: `computer`, phone: `phone`, webext: `browser` } as const;

// One text setting of a card's echo, as the capabilities board reads one; absent when the card holds none.
const textOf = (config: CapabilitySummary[`config`], key: string): string | undefined => {
    const value = String(config[key] ?? ``);
    return value === `` ? undefined : value;
};

const deviceOf = (card: CapabilitySummary, now: number): ReachDevice | undefined => {
    if (card.kind !== `device` && card.kind !== `phone` && card.kind !== `webext`) {
        return undefined;
    }
    const row = demoDevices(now).find((device) => device.card === card.id);
    return {
        card: card.id,
        kind: DEVICE_KINDS[card.kind],
        label: row?.label ?? card.id,
        machineId: row?.machineId,
        hostname: row?.facts?.hostname,
        platform: row?.platform ?? textOf(card.config, `platform`),
        online: row?.online ?? false,
        grants: switchesOn(card.config),
        yours: yours(card.id),
        others: othersFor(card.id),
    };
};

// The release box answers and holds each task for its owner's yes, as its card's status says.
const linkOutOf = (card: CapabilitySummary): ReachLinkOut | undefined => {
    const url = card.kind === `link` ? textOf(card.config, `url`) : undefined;
    if (url === undefined) {
        return undefined;
    }
    return {
        card: card.id,
        name: textOf(card.config, `name`),
        host: reachHostOf(url),
        answer: card.status.state === `active` ? `answering` : `silent`,
        terms: card.status.state === `active` ? { tasks: true, records: false, operate: false, approve: true } : undefined,
        yours: yours(card.id),
        others: othersFor(card.id),
    };
};

const serverOf = (card: CapabilitySummary): SandboxReach[`servers`][number] | undefined => {
    const host = card.kind === `ssh` ? textOf(card.config, `host`) : undefined;
    return host === undefined
        ? undefined
        : { card: card.id, host: host.toLowerCase(), user: textOf(card.config, `user`), admin: false, yours: yours(card.id), others: othersFor(card.id) };
};

const roleName = (id: string | undefined): string | undefined => (id === undefined ? undefined : (demoRoles.find((role) => role.id === id)?.label ?? id));

const shopReach = (at: URL): SandboxReach => {
    const now = Date.now();
    const cards = demoCapabilities();
    return {
        self: { sandboxId: `demo`, runsOn: owner ? { host: `ada-pc`, os: `linux/archlinux` } : undefined },
        reader: reader(),
        linksOut: cards.flatMap((card) => linkOutOf(card) ?? []),
        linksIn: owner
            ? linksList(at).links.map((link) => ({
                  id: link.id,
                  label: link.label,
                  sandboxId: link.from?.sandboxId,
                  host: link.from?.url === undefined ? undefined : reachHostOf(link.from.url),
                  terms: { tasks: link.terms.tasks, records: link.terms.records, operate: link.terms.operate, approve: link.terms.approve, role: roleName(link.terms.actsAs) },
                  lastUsedAt: link.lastUsedAt,
                  waiting: link.requests.length,
              }))
            : undefined,
        devices: cards.flatMap((card) => deviceOf(card, now) ?? []),
        servers: cards.flatMap((card) => serverOf(card) ?? []),
        people: managesPeople ? othersHere().length + ownerBesides : undefined,
        readAt: now,
    };
};

// The owner's laptop: it runs there, and hands the shop tasks and reads its records through a link the owner paired.
const laptopReach = (): SandboxReach => ({
    self: { sandboxId: LAPTOP_SANDBOX.id, runsOn: { host: `ada-laptop`, os: `macos` } },
    reader: { tier: `owner`, agents: true },
    linksOut: [
        {
            card: `acme-shop`,
            name: `acme-shop`,
            sandboxId: `demo`,
            host: reachHostOf(DEMO_DAEMON_ORIGIN),
            answer: `answering`,
            terms: { tasks: true, records: true, operate: false, approve: false },
            yours: true,
            others: 0,
        },
    ],
    linksIn: [],
    devices: [],
    servers: [],
    people: 0,
    readAt: Date.now(),
});

export const demoReach = (at: URL): SandboxReach => {
    if (at.origin === LAPTOP_SANDBOX.origin) {
        return laptopReach();
    }
    if (at.origin === new URL(DEMO_DAEMON_ORIGIN).origin) {
        return shopReach(at);
    }
    return { self: {}, reader: reader(), linksOut: [], devices: [], servers: [], readAt: Date.now() };
};
