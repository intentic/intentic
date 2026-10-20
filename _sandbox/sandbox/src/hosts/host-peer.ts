import type { CardlessHost } from "@intentic/sandbox-contract/schemas/devices";
import {
    derivedMachineId,
    HOST_NATIVE_ENVIRONMENT,
    hostConnectionKey,
    type HostEnvironment,
    isDerivedMachineId,
    type DeviceFacts,
    type HostSummary,
    type MachineIdentity,
    parseHostConnection,
} from "@intentic/sandbox-contract/schemas/hosts";
import { HOST_HEARTBEAT_MS, type HostHello, HostHelloSchema } from "@intentic/sandbox-contract/protocol/doors/host-protocol";
import type { deviceContract } from "@intentic/sandbox-contract/contracts/device.contract";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import type { ContractRouterClient } from "@orpc/contract";
import { capabilityCtx } from "../capabilities/capability.js";
import { deviceHandler, refreshDeviceSkill } from "../capabilities/handlers/device.handler.js";
import type { Services } from "../composition.js";
import type { CardRule } from "../peers/enrollment.js";
import { HostEnrollmentFieldsSchema, hostEnrollmentsDocument, hostPairConsumedDocument } from "../peers/enrollment.js";
import { PEER_BRIDGES, type PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";
import { bootstrapEnvironments } from "./environment-bootstrap.js";
import { revokeSuperseded } from "./host-dedupe.js";
import { hostCallGate } from "./host-call-gate.js";
import { hostCallRoute } from "./host-call-route.js";
import type { HostGuardDeps } from "./host-guard-deps.js";

// The user's own computer as a peer door: @intentic/machine dials in with an enrollment token and serves `deviceContract`
// over that socket. The grant is the `host` capability's config; a call that carries a program (`run_command`,
// `app_start`, `open`, typed text: the contract's one table) is judged against the owner's safety policy before it
// crosses (host-command-guard.ts), and the setup flow can pre-arm a pairing from the container's env (host-seed.ts).

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
    pairing: (id) => {
        const { card, environment } = parseHostConnection(id);
        return { card, environment, machineId: derivedMachineId(card) };
    },
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
const environmentsOf = (
    services: Services,
    card: string,
    enrolled: readonly { readonly id: string; readonly card: string; readonly environment: string; readonly machineId: string }[],
): HostEnvironment[] => {
    const records = enrolled.filter((entry) => entry.card === card);
    // Only enrolled connections can hold a socket (peers/invariant.ts), so the records name every side there is; the
    // native side is listed even before it has one, under the key that is the card itself.
    const sides = records.some((entry) => entry.environment === HOST_NATIVE_ENVIRONMENT)
        ? records
        : [{ id: hostConnectionKey(card, HOST_NATIVE_ENVIRONMENT), environment: HOST_NATIVE_ENVIRONMENT, machineId: undefined }, ...records];
    return sides
        .map(({ id: key, environment, machineId }) => {
            const state = services.hostHub.state(key);
            return {
                key: environment,
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
            card: summary.id,
            platform: environmentPlatform(summary.platform, environment.key),
            environments: [environment],
            online: environment.online,
            ...(environment.version === undefined ? {} : { version: environment.version }),
            ...(environment.facts === undefined ? {} : { facts: environment.facts }),
            ...(environment.lastSeen === undefined ? {} : { lastSeen: environment.lastSeen }),
        })),
    );

// WHICH COMPUTER AN ENROLLMENT IS ON, as its agent says it: redeeming the pairing (the enroll request) or connecting
// (`describe`'s facts), the one rule for both. Only a real machine id is learned, never a derived placeholder
// (`card:<name>`), so an id an agent said is never replaced by one standing in for it. An agent naming its environment
// must name the enrollment's own: its machine id under another install's record would join, and supersede, that
// install's keys. Nothing learned leaves the enrollment as it was, learning its id at the next connect.
export const machineIdLearned = (
    said: MachineIdentity,
    enrollment: { readonly environment: string } | undefined,
): Pick<HostEnrollmentFields, "machineId"> | undefined => {
    const { machineId, environment } = said;
    if (machineId === undefined || isDerivedMachineId(machineId)) {
        return undefined;
    }
    return environment === undefined || environment === enrollment?.environment ? { machineId } : undefined;
};

// The machine id an enrollment records, from what its agent said at connect: one write, and none when it already
// says so, the agent is too old to say, or what it said is not an id to learn (machineIdLearned).
export const identifyMachine = async (services: Pick<Services, "hosts">, id: string, facts: Pick<DeviceFacts, "machineId">): Promise<void> => {
    const learned = machineIdLearned(facts, undefined);
    if (learned !== undefined) {
        await services.hosts.amend(id, learned);
    }
};

// The enroll request's half: the record is written with the machine id its agent said (machineIdLearned), so it joins
// that computer's card from its first write; and once it holds one, the keys that computer's install held before it
// go at once (host-dedupe.ts), as they do when it connects.
const hostEnrollment = (services: Services) => ({
    learn: (said: MachineIdentity, pairing: HostEnrollmentFields): Partial<HostEnrollmentFields> => machineIdLearned(said, pairing) ?? {},
    enrolled: async (enrollment: { readonly id: string } & HostEnrollmentFields): Promise<void> => {
        if (!isDerivedMachineId(enrollment.machineId)) {
            await revokeSuperseded(services, enrollment.id);
        }
    },
});

// Every device enrollment no card holds, for the Devices screen to list beside a Withdraw button (2026-10-15): a key into
// this sandbox that no board draws, since a machine is drawn from its card. Not withdrawn here, nor at boot: the cards
// live in a workspace file a land can rewrite for a moment, and a key withdrawn on that is a real device unpaired.
export const cardlessHosts = async (services: Pick<Services, "capabilities" | "hosts">): Promise<CardlessHost[]> => {
    const enrolled = await services.hosts.list();
    if (enrolled.length === 0) {
        return [];
    }
    const cards = new Set((await services.capabilities.list()).flatMap((capability) => (capability.kind === "device" ? [capability.id] : [])));
    return enrolled.filter((entry) => !cards.has(entry.card)).map(({ id, card, environment }) => ({ id, card, environment }));
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

// `guards` is what the device gates take from above the host layer, filled where app.ts mounts these routes.
export const hostPeerRoutes = (services: Services, guards: HostGuardDeps) =>
    createPeerRoutes(services, HOST_PEER, {
        store: services.hosts,
        hub: services.hostHub,
        summaries: () => hostSummaries(services),
        codes: "device",
        enrollment: hostEnrollment(services),
        // One install connects the whole computer: whichever side the owner ran it on, the daemon puts an agent in
        // the rest from here (environment-bootstrap.ts). And the enrollment learns which computer it is on, replacing
        // the id it was derived with, the first time its agent says.
        onConnected: (id, facts) => {
            // Then, knowing which computer this is, the keys it held before this one go (host-dedupe.ts): the agent keeps
            // one per sandbox, so an older enrollment of the same machine environment is one nothing can present again.
            void identifyMachine(services, id, facts)
                .then(async () => await revokeSuperseded(services, id))
                .catch((err: Error) =>
                    services.logger.warn({ err, id }, "hosts: could not record which machine connected, or drop the keys it held before"),
                );
            bootstrapEnvironments(services, id, facts);
            // The skill was written when the card was applied, before the machine said what it is (an Intentic OS box).
            void refreshDeviceSkill(capabilityCtx(services), id).catch((err: Error) =>
                services.logger.warn({ err, id }, "hosts: could not bring the device's skill up to date with what it said as it connected"),
            );
        },
        // A call naming a distro goes to that distro's own agent while the card's Windows side is down, and any other
        // call is told which sides are up (host-call-route.ts). Asked before the gate, which judges where it runs.
        route: hostCallRoute(services),
        // The owner's safety policy, applied here since the bridge is the last thing to see a call while someone can
        // still be asked (host-call-gate.ts). The machine's own scopes remain the floor; a refusal here only stops what
        // the machine might otherwise have run.
        beforeCall: hostCallGate(services, guards),
    });
