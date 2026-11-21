import type { AuditEvent } from "@intentic/sandbox-contract/schemas/audit";
import type { RemoteService, RemoteTerminal } from "@intentic/sandbox-contract/schemas/remote-access";
import type { FromNode } from "@intentic/sandbox-contract/netd-wire";
import { createRemoteAccess, type RemoteAccess, type RemoteLink } from "./remote-access.js";
import { netdUplinks, type NetdUplinks } from "./netd-uplinks.js";
import type { RemoteAllow, RemoteServiceAction, RemoteStartInput } from "@intentic/sandbox-contract/schemas/device-remote";
import { HOST_NATIVE_ENVIRONMENT, parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import type { RemoteInfo } from "./remote-device.js";
import type { ConnectionEnvironments } from "./remote-environments.js";
import type { RemoteKeys, RemoteKeyStore } from "./remote-keys.js";
import { RemotedRefused, type RemotedControl, type TerminalAsk } from "./remoted-control.js";

// The seams remote access stands on, faked once for its suites: the device link, the keys, remoted's control routes and
// netd's half of the uplinks.

export const ALL_ON: RemoteAllow = { view: true, control: true, terminal: true };

export const infoWith = (allow: RemoteAllow = ALL_ON): RemoteInfo => ({
    version: "1.0.0",
    allow,
    monitors: [
        { id: "0", name: "Left", x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: false },
        { id: "1", name: "Main", x: 1920, y: 0, width: 2560, height: 1440, scale: 1.5, primary: true },
    ],
    environments: ["native", "wsl:archlinux"],
});

// A device link whose agent answers `start` with `info` (or refuses with `refused`), and says the uplink came up; and
// asked about remoted's Windows service, answers with `service` (or refuses with `refused` too).
export interface FakeLink extends RemoteLink {
    readonly starts: RemoteStartInput[];
    readonly services: { readonly device: string; readonly action: RemoteServiceAction }[];
}

export const SERVICE_NOT_SET_UP: RemoteService = { supported: true, installed: false, outOfDate: false, agentVersion: "1.431.0" };

export const fakeLink = (
    options: {
        readonly info?: RemoteInfo;
        readonly refused?: string;
        readonly offline?: boolean;
        readonly card?: RemoteAllow;
        readonly connect?: (uplinkId: string) => void;
        // The card's distros connected with an agent of their own; by default the key says the environment.
        readonly ownConnections?: readonly string[];
        readonly service?: RemoteService;
    } = {},
): FakeLink => {
    const starts: RemoteStartInput[] = [];
    const services: { readonly device: string; readonly action: RemoteServiceAction }[] = [];
    return {
        starts,
        services,
        refusal: (device) => (options.offline === true ? `"${device}" is not connected right now` : undefined),
        online: () => options.offline !== true,
        start: async (_device, input) => {
            starts.push(input);
            if (options.refused !== undefined) {
                throw new Error(options.refused);
            }
            options.connect?.(input.device);
            return options.info ?? infoWith();
        },
        service: async (device, action) => {
            services.push({ device, action });
            if (options.refused !== undefined) {
                throw new Error(options.refused);
            }
            return options.service ?? SERVICE_NOT_SET_UP;
        },
        cardAllows: async () => options.card ?? ALL_ON,
        environments: (device): ConnectionEnvironments => ({
            own: parseHostConnection(device).environment ?? HOST_NATIVE_ENVIRONMENT,
            ownConnections: new Set(options.ownConnections ?? []),
        }),
    };
};

export const memoryKeys = (): RemoteKeyStore & { readonly made: Map<string, RemoteKeys> } => {
    const made = new Map<string, RemoteKeys>();
    let next = 0;
    return {
        made,
        of: (uplinkId) => {
            const known = made.get(uplinkId);
            if (known !== undefined) {
                return known;
            }
            next += 1;
            const keys = { uplinkToken: `uplink-${next}`, mediaKey: Buffer.alloc(32, next).toString("base64url") };
            made.set(uplinkId, keys);
            return keys;
        },
        has: (uplinkId) => made.has(uplinkId),
        forget: (uplinkId) => {
            made.delete(uplinkId);
        },
        held: () => [...made.keys()],
    };
};

// remoted's control routes over one map of terminals; `refuse` makes the next open fail with that status and words.
export const fakeRemoted = (info: RemoteInfo = infoWith()) => {
    const terminals = new Map<string, RemoteTerminal>();
    const asked: TerminalAsk[] = [];
    const drops: string[] = [];
    let refuse: { readonly status: number; readonly words: string } | undefined;
    const control: RemotedControl = {
        info: async () => info,
        terminals: async () => [...terminals.values()],
        openTerminal: async (ask) => {
            asked.push(ask);
            if (refuse !== undefined) {
                throw new RemotedRefused(refuse.status, refuse.words);
            }
            const made = { session: ask.session, title: "pwsh", environment: ask.environment ?? "native", createdAt: 1_700_000_000_000, viewers: 0 };
            terminals.set(ask.session, made);
            return made;
        },
        closeTerminal: async (session) => terminals.delete(session),
        dropViewers: async ({ reason }) => {
            drops.push(reason);
            return true;
        },
    };
    return {
        control,
        terminals,
        asked,
        drops,
        refuseNext: (status: number, words: string) => {
            refuse = { status, words };
        },
    };
};

// netd's half: what the daemon told it, and a report as netd would send it.
export const fakeNetd = () => {
    const told: FromNode[] = [];
    const uplinks: NetdUplinks = netdUplinks((message) => told.push(message));
    const connected = new Map<string, boolean>();
    const report = (): void => uplinks.heard({ kind: "deviceUplinks", uplinks: [...connected].map(([device, up]) => ({ device, connected: up })) });
    return {
        told,
        uplinks,
        report,
        up: (device: string) => {
            connected.set(device, true);
            report();
        },
        down: (device: string) => {
            connected.set(device, false);
            report();
        },
    };
};

export interface RemoteHarness {
    readonly remote: RemoteAccess;
    readonly link: FakeLink;
    readonly keys: ReturnType<typeof memoryKeys>;
    readonly remoted: ReturnType<typeof fakeRemoted>;
    readonly netd: ReturnType<typeof fakeNetd>;
    readonly audit: AuditEvent[];
}

export const NOW = 1_800_000_000_000;

// Remote access over every fake, netd reporting from the start and the agent bringing the uplink up when started.
export const remoteHarness = (options: Parameters<typeof fakeLink>[0] = {}): RemoteHarness => {
    const netd = fakeNetd();
    const remoted = fakeRemoted(options.info);
    const link = fakeLink({ ...options, connect: (uplinkId) => netd.up(uplinkId) });
    const keys = memoryKeys();
    const audit: AuditEvent[] = [];
    const remote = createRemoteAccess({
        link,
        keys,
        control: () => remoted.control,
        iceServers: async () => [{ urls: ["stun:stun.example.test:3478"] }],
        audit: (event) => audit.push(event),
        logger: { info: () => undefined, warn: () => undefined },
        now: () => NOW,
    });
    remote.useNetd(netd.uplinks);
    netd.report();
    return { remote, link, keys, remoted, netd, audit };
};
