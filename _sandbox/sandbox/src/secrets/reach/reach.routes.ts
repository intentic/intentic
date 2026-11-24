import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
import { isKindOf, PEER_KINDS, type PeerKind } from "@intentic/sandbox-contract/policy/capabilities/capability-kinds";
import { type Capability, LinkConfigSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { InboundLinkSummary } from "@intentic/sandbox-contract/schemas/links";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { REACH_DEVICE_GRANTS, type ReachDevice, reachHostOf, type ReachLinkTerms } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { hostSummaries } from "../../hosts/host-peer.js";
import { opt } from "../../opt.js";
import { linkHello } from "../../sandboxes/link-client.js";
import { buildSandboxReach, type ReachCaller, type ReachFacts } from "./reach-builder.js";
import { readPlatformRow } from "../../store/platform-row.js";
import { whereThisRuns } from "../../system/boot/announce.js";

// GET /system/reach: what this sandbox is tied to outside itself, for the account's access map (docs/architecture/accounts.md).
// Read from what the daemon stores and the connections live now, never by calling a machine; the one thing asked of
// anyone else is each link card's far sandbox (`GET /link`), briefly, and that answer is kept a minute (a failure half a
// minute), so a map read every few minutes costs the far side nothing to speak of. The builder (secrets/reach/)
// decides what the reader is told.

type LinkCard = Extract<Capability, { kind: "link" }>;
type DeviceCard = Extract<Capability, { kind: "device" }>;
// The peers that are not a computer: a phone and one of the owner's own browsers.
const HANDHELD_KINDS = PEER_KINDS.filter((kind) => kind !== "device");
type HandheldCard = Extract<Capability, { kind: Exclude<PeerKind, "device"> }>;
type Hello = Awaited<ReturnType<typeof linkHello>>;

const HELLO_DEADLINE_MS = 4_000;
const HELLO_KEPT_MS = 60_000;
const HELLO_FAILURE_KEPT_MS = 30_000;

// Keyed by the card and the address it names, so a card pointed elsewhere is asked afresh.
const hellos = new Map<string, { readonly at: number; readonly value: Hello }>();

const helloFor = async (card: LinkCard): Promise<Hello> => {
    const config = LinkConfigSchema.parse(card.config);
    const key = `${card.id}\0${config.url}`;
    const held = hellos.get(key);
    if (held !== undefined && Date.now() - held.at < (held.value.ok ? HELLO_KEPT_MS : HELLO_FAILURE_KEPT_MS)) {
        return held.value;
    }
    const value = await linkHello({ id: card.id, config }, AbortSignal.timeout(HELLO_DEADLINE_MS)).catch(
        (error: Error): Hello => ({ ok: false, status: 0, message: error.message }),
    );
    hellos.set(key, { at: Date.now(), value });
    return value;
};

// A far daemon older than a term did not have it: tasks were all a link did, records and operating came later.
const termsOf = (hello: Extract<Hello, { ok: true }>): ReachLinkTerms => ({
    tasks: hello.value.terms.tasks ?? true,
    records: hello.value.terms.records ?? false,
    operate: hello.value.terms.operate ?? false,
    approve: hello.value.terms.approve,
    ...opt("role", hello.value.terms.role),
});

const linkOutOf = async (card: LinkCard): Promise<ReachFacts["linksOut"][number]> => {
    const config = LinkConfigSchema.parse(card.config);
    const hello = await helloFor(card);
    return {
        card: card.id,
        ...opt("name", config.name),
        ...opt("sandboxId", config.sandboxId),
        host: reachHostOf(config.url),
        answer: hello.ok ? "answering" : hello.status === 401 ? "revoked" : "silent",
        ...opt("terms", hello.ok ? termsOf(hello) : undefined),
    };
};

const linkInOf = (link: InboundLinkSummary, roles: readonly Role[], services: readonly Service[]): ReachFacts["linksIn"][number] => ({
    id: link.id,
    label: link.label,
    ...opt("sandboxId", link.from?.sandboxId),
    ...opt("host", link.from?.url === undefined ? undefined : reachHostOf(link.from.url)),
    terms: {
        tasks: link.terms.tasks,
        records: link.terms.records,
        operate: link.terms.operate,
        approve: link.terms.approve,
        ...opt("role", roles.find((role) => role.id === link.terms.actsAs)?.label),
        ...opt("runAs", services.find((service) => service.id === link.terms.runAs)?.label),
    },
    ...opt("lastUsedAt", link.lastUsedAt),
    waiting: link.requests.length,
});

const DEVICE_GRANTS: ReadonlySet<string> = new Set(REACH_DEVICE_GRANTS);

// A computer's switches that are on, in the contract's order; its identity and whether it is connected from the
// enrollments and the live doors the daemon already holds (hosts/host-peer.ts), never from asking it.
const computerOf = (card: DeviceCard, hosts: readonly HostSummary[]): Omit<ReachDevice, "yours" | "others"> => {
    const host = hosts.find((entry) => entry.id === card.id);
    const on = new Set(Object.entries(card.config).flatMap(([key, value]) => (DEVICE_GRANTS.has(key) && value === "on" ? [key] : [])));
    return {
        card: card.id,
        kind: "computer",
        label: card.id,
        ...opt("machineId", host?.facts?.machineId),
        ...opt("hostname", host?.facts?.hostname),
        platform: card.config.platform,
        online: host?.online ?? false,
        grants: REACH_DEVICE_GRANTS.filter((grant) => on.has(grant)),
    };
};

// A phone's and a browser's own switches, said in a computer's words where they mean the same.
const PHONE_GRANTS = new Map([
    ["screen", "screen"],
    ["control", "control"],
    ["write", "write"],
    ["destructive", "destructive"],
]);
const BROWSER_GRANTS = new Map([
    ["screenshot", "screen"],
    ["act", "control"],
]);

const handheldOf = (card: HandheldCard, services: Services): Omit<ReachDevice, "yours" | "others"> => {
    const words = card.kind === "phone" ? PHONE_GRANTS : BROWSER_GRANTS;
    const grants = Object.entries(card.config).flatMap(([key, value]) => {
        const grant = words.get(key);
        return value === "on" && grant !== undefined ? [grant] : [];
    });
    const live = card.kind === "phone" ? services.phoneHub.state(card.id) : services.webextHub.state(card.id);
    return { card: card.id, kind: card.kind === "phone" ? "phone" : "browser", label: card.id, platform: card.config.platform, online: live.online, grants };
};

const devicesOf = (cards: readonly Capability[], hosts: readonly HostSummary[], services: Services): ReachFacts["devices"] =>
    cards.flatMap((card) => {
        if (card.kind === "device") {
            return [computerOf(card, hosts)];
        }
        return isKindOf(card, HANDHELD_KINDS) ? [handheldOf(card, services)] : [];
    });

const serversOf = (cards: readonly Capability[]): ReachFacts["servers"] =>
    cards.flatMap((card) =>
        card.kind === "ssh"
            ? [{ card: card.id, host: card.config.host.toLowerCase(), ...opt("user", card.config.user), admin: card.config.adminPassword !== undefined }]
            : [],
    );

const runsOnOf = (services: Services): ReachFacts["runsOn"] => {
    const where = whereThisRuns(services.config);
    return { ...opt("host", where.host), ...opt("os", where.os) };
};

const gather = async (services: Services, caller: ReachCaller, owner: string | undefined): Promise<ReachFacts> => {
    const full = caller.tier === "owner" || caller.tier === "maintainer";
    const [roster, cards, inbound, roles, serviceRows, org, sandboxId, hosts] = await Promise.all([
        services.members.list(),
        services.capabilities.list(),
        full ? services.inboundLinks.list() : Promise.resolve([]),
        services.roles.list(),
        services.services.list(),
        services.orgPolicy.current(),
        readPlatformRow(services.config.historyRoot),
        hostSummaries(services),
    ]);
    return {
        caller,
        owner,
        roster,
        sandboxId,
        runsOn: runsOnOf(services),
        ...opt("org", org === undefined ? undefined : { id: org.orgId, name: org.orgName }),
        linksOut: await Promise.all(cards.flatMap((card) => (card.kind === "link" ? [linkOutOf(card)] : []))),
        linksIn: inbound.map((link) => linkInOf(link, roles, serviceRows)),
        devices: devicesOf(cards, hosts, services),
        servers: serversOf(cards),
        fleet: cards.find((card) => card.kind === "fleet")?.id,
        readAt: Date.now(),
    };
};

// A person, never a program: the answer is shaped for whoever reads it. With no sign-in at all (loopback), the owner.
const readerOf = (services: Services, context: OrpcContext, owner: string | undefined): ReachCaller => {
    if (services.auth === undefined) {
        return { email: owner ?? "", tier: "owner" };
    }
    if (context.identity === undefined) {
        throw new ORPCError("FORBIDDEN", { message: "what a sandbox is tied to is read by a person, not a program" });
    }
    return context.identity;
};

export const createReachRoutes = (services: Services) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        reach: i.reach.handler(async ({ context }) => {
            const owner = await services.ownerEmail();
            return buildSandboxReach(await gather(services, readerOf(services, context, owner), owner));
        }),
    };
};
