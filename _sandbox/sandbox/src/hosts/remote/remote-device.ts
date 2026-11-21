import type { Capability, DeviceConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RemoteAllow, RemoteServiceAction, RemoteServiceResult, RemoteStartInput, RemoteStartResult } from "@intentic/sandbox-contract/schemas/device-remote";
import {
    DEVICE_FEATURE_REMOTE,
    DEVICE_FEATURE_REMOTE_ICE,
    DEVICE_FEATURE_REMOTE_SERVICE,
    type DeviceFacts,
    deviceSupports,
    environmentKeyOf,
    parseHostConnection,
} from "@intentic/sandbox-contract/schemas/hosts";
import type { HostHub } from "../host-peer.js";
import type { RemoteLink } from "./remote-access.js";
import { type ConnectionEnvironments, isDistro } from "./remote-environments.js";

/* THE ONE MODULE THAT SPEAKS TO THE MACHINE AGENT ABOUT REMOTE ACCESS (2026-11-20): the device contract's `remoteStart`
   (schemas/device-remote.ts), the `remote` feature an agent advertises (DEVICE_FEATURE_REMOTE), and the card's three
   switches (DeviceScopesSchema's `remoteView`, `remoteControl`, `remoteTerminal`).

   remoteStart({ device, uplinkToken, mediaKey }) has the agent run `intentic-remoted` with these secrets and the
   switches as they stand, waits until its uplink is up (ten seconds at most), and answers what remoted serves. It is
   refused (FORBIDDEN, naming the switches) while all three are off. The daemon never calls `remoteStop`: netd
   withdrawing the device closes the uplink (4003) and remoted stops dialling it, and the agent drops an uplink whose
   link went or whose switches all went off by itself.

   remoteService({ action }) reads, installs or removes remoted's Windows service for the lock screen and administrator
   prompts, on an agent advertising `remote-service` (a Windows one); an install or a removal waits on the UAC prompt
   the person at the computer answers, up to ten minutes, inside the hub's own ceiling on a device call. */

// What remoteStart answers, and what remoted's own `GET /info` is read as (remoted-control.ts).
export type RemoteInfo = RemoteStartResult;

// What an agent is sent: `iceServers` only to one advertising `remote-ice`, since the input schema is strict and an older
// agent would refuse the whole call over a field it does not know. Pure.
export const startInputFor = (facts: Pick<DeviceFacts, "features"> | undefined, input: RemoteStartInput): RemoteStartInput => {
    if (input.iceServers === undefined || deviceSupports(facts, DEVICE_FEATURE_REMOTE_ICE)) {
        return input;
    }
    const { iceServers: _left, ...older } = input;
    return older;
};

// The agent answers in the contract's shape (its server checks it against the contract on the way out).
const remoteStart = async (hub: HostHub, device: string, input: RemoteStartInput): Promise<RemoteInfo> => {
    const client = hub.client(device);
    if (client === undefined) {
        throw new Error(hub.offline(device));
    }
    return await client.remoteStart(startInputFor(hub.state(device).facts, input));
};

// Asked only of an agent that has it: an older one, or one not on Windows, would refuse the procedure without a word a
// person can act on.
const remoteService = async (hub: HostHub, device: string, action: RemoteServiceAction): Promise<RemoteServiceResult> => {
    const client = hub.client(device);
    if (client === undefined) {
        throw new Error(hub.offline(device));
    }
    if (!deviceSupports(hub.state(device).facts, DEVICE_FEATURE_REMOTE_SERVICE)) {
        throw new Error(
            `The agent on "${device}" cannot set up the lock screen and administrator prompts: it is not on Windows, or too old. Update that device's agent, then try again.`,
        );
    }
    return await client.remoteService({ action });
};

// What the device's card allows, read before remoted has said: each switch `on` in the card's config, as the agent
// reads its grant (device/remote/remoted-files.ts `allowFrom`). A card stored before the switches existed has none, and
// all three read off.
const cardAllows = (config: Partial<DeviceConfig> | undefined): RemoteAllow => ({
    view: config?.remoteView === "on",
    control: config?.remoteControl === "on",
    terminal: config?.remoteTerminal === "on",
});

// A connection's own environment: what its agent said at connect, else what its key says.
const environmentOf = (hub: HostHub, key: string): string => {
    const facts = hub.state(key).facts;
    return facts === undefined ? parseHostConnection(key).environment : environmentKeyOf(facts);
};

// The connection's own environment, and the distros of its card that hold a connection of their own
// (remote-environments.ts has the rule this feeds).
const environmentsOf = (hub: HostHub, device: string): ConnectionEnvironments => {
    const { card } = parseHostConnection(device);
    const ownConnections = new Set(
        hub
            .known()
            .filter((key) => key !== device && parseHostConnection(key).card === card)
            .map((key) => environmentOf(hub, key))
            .filter(isDistro),
    );
    return { own: environmentOf(hub, device), ownConnections };
};

// The device link as remote access reads it: the hub's socket and the agent's features, the card's switches, and
// remoteStart on the device's own connection.
export const hubRemoteLink = (hub: () => HostHub, cards: () => Promise<readonly Capability[]>): RemoteLink => ({
    refusal: (device) => {
        if (hub().client(device) === undefined) {
            return hub().offline(device);
        }
        return deviceSupports(hub().state(device).facts, DEVICE_FEATURE_REMOTE)
            ? undefined
            : `The agent on "${device}" is too old for a remote screen or terminal. Update that device's agent, then try again.`;
    },
    online: (device) => hub().online(device),
    start: async (device, input) => await remoteStart(hub(), device, input),
    service: async (device, action) => await remoteService(hub(), device, action),
    cardAllows: async (device) => {
        const { card } = parseHostConnection(device);
        const found = (await cards()).find((capability) => capability.kind === "device" && capability.id === card);
        return cardAllows(found?.kind === "device" ? found.config : undefined);
    },
    environments: (device) => environmentsOf(hub(), device),
});
