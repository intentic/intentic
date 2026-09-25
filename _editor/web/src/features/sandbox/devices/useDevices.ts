import {
    type Device,
    type DeviceAgentOp,
    type DeviceCommand,
    type DeviceCommandResult,
    type DeviceFlowLine,
    type DeviceSandboxFlowInput,
    type DeviceSandboxOp,
    type SandboxResourcesAsk,
    type SandboxShape,
    type SandboxShapeWhen,
    hostHoldingPath,
    hostRunningSandbox,
    SyncStatusSchema,
} from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { computed, type ComputedRef, type Ref } from "vue";
import { sandboxError, sandboxJson, sandboxRequest } from "../client/sandboxClient";
import { SandboxHttpError } from "../client/sandboxHttpError";
import { rpcQuery } from "../client/rpcQuery";
import { sandboxRpc } from "../client/sandboxRpc";
import { readIntenticLines } from "../../../lib/intenticStream";
import { SYNC_HEALTH } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Devices the daemon can see, merging both report paths (see hosts/device-reports.ts). Polled on a slow cadence and
// pushed on the `hosts` domain when a machine's reading actually moves, so state is a snapshot cached by the daemon
// between polls and an idle tab costs nothing extra.

const POLL_MS = 10_000;

// Callers opt into polling; a non-polling reader still gets the shared cache, refreshed once on mount.
export function useDevices({ poll = true }: { poll?: boolean } = {}): {
    devices: ComputedRef<Device[]>;
    /** When this list landed here: the clock every freshness verdict on a device is judged against. */
    readAt: ComputedRef<number>;
    error: ComputedRef<string | undefined>;
    isLoading: Ref<boolean>;
    refetch: () => void;
} {
    const { query, error } = useSandboxQuery({ ...rpcQuery(`system.devices`), refetchInterval: poll ? POLL_MS : false });
    return {
        devices: computed(() => query.data.value?.devices ?? []),
        // Restored with the cache on reload, so a hydrated list is aged from when it was actually read, not from now.
        readAt: computed(() => query.dataUpdatedAt.value),
        error,
        // True only for the first fetch; a refetch must never blank an already-populated list.
        isLoading: query.isLoading,
        refetch: () => void query.refetch(),
    };
}

// One string field from a loosely-parsed stream frame, or undefined.
const frameText = (line: Record<string, unknown>, key: string): string | undefined => (typeof line[key] === `string` ? line[key] : undefined);

// Payload shared by every device-sandbox op, all issued through one streaming call. `onLine` gets progress
// as it prints; `hash` is rebuild's digest, `shape`/`when` are set-shape's whole shape and its timing, `resources`
// the old reshape op's delta (sent only to an agent older than set-shape, see shapeFlow).
export interface DeviceSandboxPayload {
    hash?: string | undefined;
    shape?: SandboxShape | undefined;
    when?: SandboxShapeWhen | undefined;
    resources?: SandboxResourcesAsk | undefined;
    // The short-lived setup code reconnect redeems on the host machine for a drifted container's missing values.
    setupCode?: string | undefined;
    onLine?: ((line: string) => void) | undefined;
    // Set when the op is aimed at the sandbox relaying it: the daemon dies mid-stream, so a lost connection is the
    // op landing rather than a failure. Only the caller knows which sandbox is serving the page.
    severing?: boolean | undefined;
}

// hash/resources/setupCode are included only when present; the schema rejects an explicit undefined.
const flowInput = (
    hostId: string,
    slug: string,
    op: DeviceSandboxOp,
    { hash, shape, when, resources, setupCode }: DeviceSandboxPayload,
): DeviceSandboxFlowInput => ({
    id: hostId,
    slug,
    op,
    ...(hash === undefined ? {} : { hash }),
    ...(shape === undefined ? {} : { shape }),
    ...(when === undefined ? {} : { when }),
    ...(resources === undefined ? {} : { resources }),
    ...(setupCode === undefined ? {} : { setupCode }),
});

// Stands in for the device's own sentence when the op that succeeded took the connection carrying it down: the
// daemon relaying the call lived in the container the call acted on, so no result frame can ever arrive.
const severedOutcome = (op: DeviceSandboxOp, slug: string): string =>
    op === `remove`
        ? `Removed "${slug}" from this device: its container, its files and its history are gone.`
        : `"${slug}" took this connection down with it, which is what ${op} does from inside it. What it is now shows up once the page reconnects.`;

// Everything the flow said: its result sentence, and its refusal if it sent one. A refusal is returned rather than
// thrown so the caller can tell one the device SENT from the connection dying under it.
const flowSaid = async (
    frames: AsyncIterable<DeviceFlowLine>,
    onLine: ((line: string) => void) | undefined,
): Promise<{ outcome: string | undefined; refusal: string | undefined }> => {
    let outcome: string | undefined;
    for await (const line of readIntenticLines(frames)) {
        if (line[`kind`] === `line`) {
            const text = frameText(line, `text`);
            if (text !== undefined) {
                onLine?.(text);
            }
            continue;
        }
        if (line[`kind`] === `error`) {
            return { outcome, refusal: frameText(line, `message`) ?? `That operation failed on the device.` };
        }
        if (line[`kind`] === `result`) {
            outcome = frameText(line, `message`) ?? outcome;
        }
    }
    return { outcome, refusal: undefined };
};

/**
 * A flow's stream that broke, or ended, before the device's last word: the machine carries on with nobody listening,
 * so this is never its refusal. `transport` is what the browser said when the stream broke; absent when it just ended.
 */
export class DeviceFlowLostError extends Error {
    constructor(readonly transport: string | undefined) {
        const browser = transport === undefined ? `` : ` The browser said: "${transport}".`;
        super(`Lost contact with that device while this was running: it may still have finished. Refresh to see where it got to.${browser}`);
    }
}

// A stream ending without a terminal frame means the connection dropped, not that the operation stopped;
// the next fleet read reflects the real outcome. `severed` is that drop's answer for an op that causes it.
const outcomeOf = async (
    frames: AsyncIterable<DeviceFlowLine>,
    onLine: ((line: string) => void) | undefined,
    severed: string | undefined,
): Promise<string> => {
    const said = await flowSaid(frames, onLine).catch((error: unknown) => {
        if (severed === undefined) {
            // Read by shape: the browser's own abort is a DOMException, which not every DOM makes an Error.
            const browser = errorMessage(error, ``);
            throw new DeviceFlowLostError(browser === `` ? undefined : browser);
        }
        return { outcome: severed, refusal: undefined };
    });
    if (said.refusal !== undefined) {
        throw new Error(said.refusal);
    }
    if (said.outcome !== undefined) {
        return said.outcome;
    }
    if (severed !== undefined) {
        return severed;
    }
    throw new DeviceFlowLostError(undefined);
};

export async function manageDeviceSandbox(hostId: string, slug: string, op: DeviceSandboxOp, payload: DeviceSandboxPayload = {}): Promise<string> {
    const frames = await sandboxRpc.system.manageDeviceSandbox(flowInput(hostId, slug, op, payload));
    return outcomeOf(frames, payload.onLine, payload.severing === true ? severedOutcome(op, slug) : undefined);
}

// Update/restart kills the process serving the request, so an untimely stream end here is success, not
// manageDeviceSandbox's lost-connection case. `settled` only says a result frame arrived; the agent version
// on the next poll is the real answer.
export async function runDeviceAgentFlow(
    hostId: string,
    op: DeviceAgentOp,
    { onLine }: { onLine?: (line: string) => void } = {},
): Promise<{ message: string | undefined; settled: boolean }> {
    const frames = await sandboxRpc.system.runDeviceAgentFlow({ id: hostId, op });
    let message: string | undefined;
    for await (const line of readIntenticLines(frames)) {
        if (line[`kind`] === `line`) {
            const text = frameText(line, `text`);
            if (text !== undefined) {
                onLine?.(text);
            }
            continue;
        }
        // An `error` frame means the device refused (its switch off, or its agent too old), not a dropped connection.
        if (line[`kind`] === `error`) {
            throw new Error(frameText(line, `message`) ?? `That device wouldn't update its agent.`);
        }
        if (line[`kind`] === `result`) {
            message = frameText(line, `message`) ?? message;
        }
    }
    return { message, settled: message !== undefined };
}

// What a command acts on, beyond its own name: a pairing to scope the sync switches to, for `sync-install` which
// half to enroll and the folder on that device, and for the two per-port mirror switches the one number they are
// about. No token and no command line — the daemon builds both.
export interface DeviceCommandAsk {
    sandboxId?: string | undefined;
    mode?: `sync` | `mirror` | undefined;
    localDir?: string | undefined;
    port?: number | undefined;
}

// Runs one device CLI action by a closed-set name; the daemon builds the argv (hosts/device-commands.ts),
// never forwarding free text. `ok: false` is the device's own refusal as a result; only an unreachable
// device rejects the promise.
export async function runDeviceCommand(hostId: string, command: DeviceCommand, ask: DeviceCommandAsk = {}): Promise<DeviceCommandResult> {
    return sandboxRpc.system.runDeviceCommand({
        id: hostId,
        command,
        ...(ask.sandboxId === undefined ? {} : { sandboxId: ask.sandboxId }),
        ...(ask.mode === undefined ? {} : { mode: ask.mode }),
        ...(ask.localDir === undefined ? {} : { localDir: ask.localDir }),
        ...(ask.port === undefined ? {} : { port: ask.port }),
    });
}

// The same call for a command that takes its own answer down with it: `dev-restart` restarts the container serving
// this request, so the connection dropping IS the expected ending, reported as `undefined`. Anything the daemon
// managed to answer — a refusal, a bad request, the device being unreachable — still throws, since a reply that
// arrived is a reply about what happened.
export async function runSeveringDeviceCommand(hostId: string, command: DeviceCommand): Promise<DeviceCommandResult | undefined> {
    try {
        return await runDeviceCommand(hostId, command);
    } catch (error) {
        if (error instanceof SandboxHttpError) {
            throw error;
        }
        return undefined;
    }
}

// Revokes one device's desktop-sync key without touching others' enrollment. Drops it from
// authorized_keys; the device notices on its next poll and stops mirroring itself.
export async function revokeSyncDevice(machine: string): Promise<void> {
    const response = await sandboxRequest(`/system/authorized-key/${encodeURIComponent(machine)}`, { method: `DELETE` });
    if (!response.ok) {
        throw await sandboxError(response, { method: `DELETE`, path: `/system/authorized-key/{machine}` });
    }
}

// The connected, online device running a given sandbox slug, if any. The rule itself is the contract's
// (`hostRunningSandbox`), shared with the daemon so a button here and a turn's own reasoning cannot disagree
// about which machine is reachable. Shares the Devices query without polling it itself.
export function useHostRunning(slug: () => string | undefined): ComputedRef<string | undefined> {
    const { devices } = useDevices({ poll: false });
    return computed(() => hostRunningSandbox(devices.value, slug()));
}

// The same question for a command written for a PATH out there — the dev checkout, the log beside it — where the one
// above answers for the container alone. A PC's Windows side and the distro on it report the same containers, so only
// the path picks between their doors; the daemon reads the same rule and sends the crossing with the command, so a PC
// connected on one side only still gets a button rather than a printed command.
export function useHostHolding(slug: () => string | undefined, path: () => string | undefined): ComputedRef<string | undefined> {
    const { devices } = useDevices({ poll: false });
    return computed(() => hostHoldingPath(devices.value, slug(), path()));
}

// Reads /system/sync, not /system/devices, to avoid polling every laptop just to draw a badge.
const HEALTH_POLL_MS = 60_000;

export function useSyncHealth(): {
    stoppedOn: ComputedRef<string[]>;
    heldPorts: ComputedRef<number[]>;
    syncOffered: ComputedRef<boolean>;
    filesUnsynced: ComputedRef<boolean>;
} {
    const { query } = useSandboxQuery({
        queryKey: SYNC_HEALTH.of(),
        queryFn: async () => SyncStatusSchema.parse(await sandboxJson(`/system/sync`)),
        refetchInterval: HEALTH_POLL_MS,
    });
    const machines = computed(() => query.data.value?.machines ?? []);
    return {
        // Whether offering desktop sync is honest here at all; a daemon that cannot say is taken as "no offer".
        syncOffered: computed(() => query.data.value?.available === true),
        // No machine holds a copy of this sandbox's files. Read strictly off `false`: an unread status and a daemon
        // that cannot answer both mean "do not claim there is no copy".
        filesUnsynced: computed(() => query.data.value?.syncing === false),
        // Machines whose sync watcher has stopped, though other signals still read healthy.
        stoppedOn: computed(() => machines.value.filter((report) => !report.agent.running).map((report) => report.hostname)),
        // ONLY the ports another paired sandbox took, and deliberately not every port that missed localhost. The
        // other outcomes are a machine working correctly and staying that way — a foreign program holding the
        // number, or somebody telling this device to leave it alone — and counting those here is what put a
        // standing badge on the tab of a fleet with nothing wrong with it. This one is ours, it has a remedy on
        // the Devices tab (stop the sandbox holding the port), and it is an event: something changed to cause it.
        heldPorts: computed(() => [
            ...new Set(machines.value.flatMap((report) => report.ports.filter((port) => port.state === `held-by-sandbox`).map((port) => port.port))),
        ]),
    };
}
