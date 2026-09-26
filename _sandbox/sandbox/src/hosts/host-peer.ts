import {
    derivedMachineId,
    HOST_HEARTBEAT_MS,
    HOST_NATIVE_ENVIRONMENT,
    hostEntryOf,
    hostConnectionKey,
    type deviceContract,
    hostEnvironmentOf,
    type HostEnvironment,
    isDerivedMachineId,
    type DeviceFacts,
    type HostHello,
    HostHelloSchema,
    type DeviceScopes,
    type HostSummary,
} from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";
import { capabilityCtx } from "../capabilities/capability.js";
import { deviceHandler } from "../capabilities/handlers/device.handler.js";
import type { Services } from "../composition.js";
import type { CardRule } from "../peers/enrollment.js";
import { HostEnrollmentFieldsSchema, hostEnrollmentsDocument, hostPairConsumedDocument } from "../peers/enrollment.js";
import { PEER_BRIDGES, type PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";
import { bootstrapEnvironments } from "./environment-bootstrap.js";
import { commandInCall, judgeHostCommand } from "./host-command-guard.js";

// The user's own computer as a peer door: @intentic/machine dials in with an enrollment token and serves `deviceContract`
// over that socket. The grant is the `host` capability's config; a `run_command` is judged against the owner's safety
// policy before it crosses (host-command-guard.ts), and the setup flow can pre-arm a pairing from the container's env
// (host-seed.ts).

export type HostClient = ContractRouterClient<typeof deviceContract>;
// @intentic/machine's build version, so an old binary is visible rather than mysteriously missing a tool.
export interface HostAnnounced {
    readonly version: string;
}
export type HostHub = PeerHub<HostClient, HostAnnounced, DeviceFacts, DeviceScopes>;
// What a host enrollment records beside its digest: which computer, which OS install on it, which card lends it.
export type HostEnrollmentFields = { readonly card: string; readonly environment: string; readonly machineId: string };
export type HostStore = PeerStore<HostEnrollmentFields>;

// ONE CARD IS ONE COMPUTER, EACH OS INSTALL ON IT A CONNECTION OF THAT CARD, and the record says which. The owner asks to
// pair a connection by its key (`<card>` or `<card>::wsl:<distro>`), which is parsed here, once, into the card and the
// environment the enrollment records; from then on the card is read off the record, a rename is a new label on it,
// and the connection key follows from the label. The machine id is the card's derived one until the agent says its own.
export const HOST_CARD_RULE: CardRule<HostEnrollmentFields> = {
    of: (entry) => entry.card,
    pairing: (id) => ({ card: hostEntryOf(id), environment: hostEnvironmentOf(id), machineId: derivedMachineId(hostEntryOf(id)) }),
    relabel: (entry, card) => ({ ...entry, card, id: hostConnectionKey(card, entry.environment) }),
};

export const HOST_PEER: PeerDoor<HostHello, HostAnnounced, typeof HostEnrollmentFieldsSchema.shape> = {
    slug: PEER_BRIDGES.device,
    noun: "device",
    listKey: "hosts",
    store: {
        documents: { enrollments: hostEnrollmentsDocument, consumed: hostPairConsumedDocument },
        key: "hosts",
        prefix: "iht_",
        extra: HostEnrollmentFieldsSchema.shape,
        card: HOST_CARD_RULE,
    },
    hub: {
        domain: "hosts",
        // Keepalive and liveness in one, and the agent's own watchdog is timed off the same number, which is
        // why it lives in the contract both sides read (host-protocol.ts) rather than here.
        heartbeatMs: HOST_HEARTBEAT_MS,
        callTimeoutMs: 15 * 60 * 1000,
        offline: (id) => `"${id}" is not connected right now: the device is asleep, offline, or its agent isn't running.`,
    },
    hello: { schema: HostHelloSchema, announced: (hello) => ({ version: hello.version }) },
    scopesKind: "device",
    mcp: { serverName: (id) => `intentic-machine:${id}` },
    expired: "pairing expired, click Connect again in your browser for a fresh command.",
};

// Native first, then distros by name: the side that owns the screen leads, and the order is stable so a row never
// jumps between reads.
const byEnvironment = (a: HostEnvironment, b: HostEnvironment): number =>
    Number(a.key !== HOST_NATIVE_ENVIRONMENT) - Number(b.key !== HOST_NATIVE_ENVIRONMENT) || a.key.localeCompare(b.key);

// Every environment of one machine: its native connection (always listed, offline until it connects once), every
// sibling that has held a socket, and every sibling this sandbox has an enrollment for. Enrollments are read because
// hub liveness resets on a daemon restart — without them a distro that has not dialled in yet would vanish from its own
// computer rather than reading as asleep. A card is a computer, so a card with nothing connected is still a computer
// with one environment nobody has reached. Which card an enrollment is a connection of is the record's own say.
const environmentsOf = (services: Services, card: string, enrolled: readonly { readonly id: string; readonly card: string; readonly machineId: string }[]): HostEnvironment[] => {
    const records = new Map(enrolled.filter((entry) => entry.card === card).map((entry) => [entry.id, entry]));
    // Only enrolled connections can hold a socket (peers/invariant.ts), so the records name every side there is.
    const keys = new Set([card, ...records.keys()]);
    return [...keys]
        .map((key) => {
            const state = services.hostHub.state(key);
            const machineId = records.get(key)?.machineId;
            return {
                key: hostEnvironmentOf(key),
                ...(machineId === undefined || isDerivedMachineId(machineId) ? {} : { machineId }),
                online: state.online,
                ...(state.announced === undefined ? {} : { version: state.announced.version }),
                ...(state.facts === undefined ? {} : { facts: state.facts }),
                ...(state.lastSeen === undefined ? {} : { lastSeen: state.lastSeen }),
            };
        })
        .toSorted(byEnvironment);
};

// The owner's view of their machines: each host capability plus whatever the hub currently knows. Enrollment state must
// distinguish "added but never connected" from "connected but asleep".
export const hostSummaries = async (services: Services): Promise<HostSummary[]> => {
    const cards = await services.capabilities.list();
    // A card is what makes a machine a machine, so with none there is nothing for an enrollment to be an environment
    // OF, and the store is not read at all — the ordinary state of a sandbox nobody has connected a computer to.
    if (!cards.some((capability) => capability.kind === "device")) {
        return [];
    }
    const enrolled = await services.hosts.list();
    return cards.flatMap((capability): HostSummary[] => {
        if (capability.kind !== "device") {
            return [];
        }
        const environments = environmentsOf(services, capability.id, enrolled);
        // The native environment leads the list, and its state is the machine's own: every reader that asks whether
        // "this device" is online means the side named after the card.
        const native = environments[0];
        return [
            {
                id: capability.id,
                platform: capability.config.platform,
                environments,
                online: native?.online ?? false,
                ...(native?.version === undefined ? {} : { version: native.version }),
                ...(native?.facts === undefined ? {} : { facts: native.facts }),
                ...(native?.lastSeen === undefined ? {} : { lastSeen: native.lastSeen }),
            },
        ];
    });
};

// A distro is a Linux install that happens to sit on a Windows PC: its own platform, not its card's, so every rule
// reading a row's platform (which installer re-connects it, whether two doors can be one environment) is answered
// about the environment rather than about the machine hosting it.
const environmentPlatform = (card: string, environment: string): string => (environment.startsWith("wsl:") ? "linux" : card);

// The machines as the device list addresses them: one entry per ENVIRONMENT, keyed by its own connection. Each holds
// its own agent binary, its own socket and its own version, so each is asked for its own reading and offered its own
// verbs; folding them into the card's native side is what left a distro's agent with no door to update through.
export const hostConnections = (summaries: readonly HostSummary[]): HostSummary[] =>
    summaries.flatMap((summary) =>
        summary.environments.map((environment) => ({
            id: hostConnectionKey(summary.id, environment.key),
            platform: environmentPlatform(summary.platform, environment.key),
            environments: [environment],
            online: environment.online,
            ...(environment.version === undefined ? {} : { version: environment.version }),
            ...(environment.facts === undefined ? {} : { facts: environment.facts }),
            ...(environment.lastSeen === undefined ? {} : { lastSeen: environment.lastSeen }),
        })),
    );

// The machine id an enrollment records, from what its agent said at connect: one write, and none when it already
// says so or the agent is too old to say.
export const identifyMachine = async (services: Pick<Services, "hosts">, id: string, facts: Pick<DeviceFacts, "machineId">): Promise<void> => {
    if (facts.machineId !== undefined) {
        await services.hosts.amend(id, { machineId: facts.machineId });
    }
};

// A card is the whole of a device's grant, so an enrollment outliving one is a credential nothing lists and nothing can
// withdraw: dropped with the rest of that machine's access. A carded device is left alone, since its card owns it.
export const revokeCardlessHost = async (services: Services, id: string): Promise<boolean> => {
    if (id === "" || !(await services.hosts.enrolled(id))) {
        return false;
    }
    if ((await services.capabilities.list()).some((capability) => capability.kind === "device" && capability.id === id)) {
        return false;
    }
    await deviceHandler.remove?.(capabilityCtx(services), id, {});
    return true;
};

export const hostPeerRoutes = (services: Services) =>
    createPeerRoutes(services, HOST_PEER, {
        store: services.hosts,
        hub: services.hostHub,
        summaries: () => hostSummaries(services),
        // One install connects the whole computer: whichever side the owner ran it on, the daemon puts an agent in
        // the rest from here (environment-bootstrap.ts). And the enrollment learns which computer it is on, replacing
        // the id it was derived with, the first time its agent says.
        onConnected: (id, facts) => {
            void identifyMachine(services, id, facts).catch((err: unknown) => services.logger.warn({ err, id }, "hosts: could not record which machine connected"));
            bootstrapEnvironments(services, id, facts);
        },
        // The owner's safety policy, applied here since the bridge is the last thing to see a call while someone can
        // still be asked. The machine's own scopes remain the floor; a refusal here only stops what the machine might
        // otherwise have run.
        beforeCall: async (payload, call) => {
            const command = commandInCall(payload);
            if (command === undefined) {
                return undefined;
            }
            return judgeHostCommand(services, { machine: call.id, command, conversationId: call.conversationId });
        },
    });
